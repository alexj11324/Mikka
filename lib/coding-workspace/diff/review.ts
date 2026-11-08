import 'server-only'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { reviewMutation, reviewComment, WorkspaceReviewError, type ReviewBoard, type ReviewMutation } from '@mikka/protocol/coding-workspace-review'
import { secretMaskerFor } from '../../secrets/runtime'
import { maskDeep } from '../../secrets/mask'
import { runChanged } from '../../live/panels'
import { LEASED_RUN_STATUSES } from '../../run-retry'
import { diffDigest, validateReviewAnchor } from './patch'
import { resolveReviewScope, withReviewTransaction, type ReviewActor } from './authority'
import { readDiffSnapshot, readStoredDiffFile } from './store'
import { diffFile, type DiffDependencies } from './service'

const cursorSchema = z.strictObject({ version: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative(),
  at: z.iso.datetime(), id: z.uuid() })

export async function readReviewBoard(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  snapshotId: string, cursor?: string): Promise<ReviewBoard> {
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (client, scope) => {
  const snapshot = await readDiffSnapshot(client, scope, snapshotId)
  let after: z.infer<typeof cursorSchema> | undefined
  if (cursor) {
    try { after = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))) }
    catch (cause) { throw new CodingWorkspaceError('workspace_invalid_request', { cause }) }
    if (after.version !== snapshot.revision.version) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  }
  const { rows: [page] } = await client.query<{ revision: number; comments: (Record<string, unknown> & { cursorTime: string; id: string })[] }>(
    `WITH selected AS (
      SELECT c.id,c."threadId",c."userId",c.anchor,c.body,c.draft,root.resolved,
        old.metadata->>'fileVersion' IS DISTINCT FROM current.metadata->>'fileVersion' AS outdated,
        c."createdAt",c."updatedAt",to_char(c."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
      FROM coding_workspace_review_comments c JOIN coding_workspace_review_comments root ON root.id=c."threadId" AND root."boardId"=c."boardId"
      JOIN coding_workspace_snapshot_files old ON old."snapshotId"=c."snapshotId" AND old.path=c.anchor->>'path'
      LEFT JOIN coding_workspace_snapshot_files current ON current."snapshotId"=$3 AND current.path=c.anchor->>'path'
      WHERE c."boardId"=$1 AND (NOT c.draft OR c."userId"=$2) AND (NOT root.draft OR root."userId"=$2)
        AND ($4::timestamptz IS NULL OR (c."createdAt",c.id)>($4::timestamptz,$5::uuid))
      ORDER BY c."createdAt",c.id LIMIT 101
    ) SELECT b.revision,coalesce((SELECT jsonb_agg(to_jsonb(selected) ORDER BY "createdAt",id) FROM selected),'[]'::jsonb) AS comments
      FROM coding_workspace_review_boards b WHERE b.id=$1`, [scope.boardId, actor.userId, snapshotId, after?.at ?? null, after?.id ?? null])
  if (!page) throw new WorkspaceReviewError('workspace_review_unavailable')
  if (after && after.revision !== page.revision) throw new WorkspaceReviewError('workspace_review_conflict')
  const masks = await Promise.all([
    secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: scope.identity.ownerId }),
    secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId }),
  ])
  // Local collaboration has its own Task ACL even when GitHub access was
  // removed. It returns no native provider body or source patch, and its
  // retained source metadata still obeys the current secret policy.
  if (masks.some(mask => !isDeepStrictEqual(maskDeep(snapshot, mask), snapshot))) throw new CodingWorkspaceError('workspace_path_unavailable')
  const selected = page.comments.slice(0, 100)
  const comments = selected.map(row => {
    const { cursorTime: _cursor, ...value } = row
    const comment = reviewComment.parse({ ...value, createdAt: new Date(String(value.createdAt)).toISOString(), updatedAt: new Date(String(value.updatedAt)).toISOString() })
    if (masks.some(mask => !isDeepStrictEqual(maskDeep(comment.anchor, mask), comment.anchor))) throw new CodingWorkspaceError('workspace_path_unavailable')
    return { ...comment, body: masks.reduce((body, mask) => mask(body), comment.body) }
  })
  return { revision: page.revision, snapshot, comments,
    nextCursor: page.comments.length > 100 ? Buffer.from(JSON.stringify({ version: snapshot.revision.version, revision: page.revision,
      at: selected.at(-1)!.cursorTime, id: selected.at(-1)!.id })).toString('base64url') : null,
    permissions: { canComment: actor.credential.kind !== 'device', canSendToAgent: actor.userId === scope.identity.ownerId && actor.credential.kind === 'session',
      canReadLive: actor.userId === scope.identity.ownerId && !scope.stopped && LEASED_RUN_STATUSES.some(status => status === scope.status) } }
  })
}

export type ReviewMutationReceipt = { requestId: string; revision: number; action: ReviewMutation['action'];
  commentId?: string; threadId?: string; changed?: number; audit?: { before: string | boolean; after: string | boolean } }

export async function mutateReview(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  snapshotId: string, raw: unknown, signal?: AbortSignal): Promise<ReviewMutationReceipt> {
  if (actor.credential.kind === 'device') throw new WorkspaceReviewError('workspace_review_unavailable')
  const input = reviewMutation.parse(raw)
  const scope = await resolveReviewScope(deps.database, deps.membership, actor, runId, repoId)
  const snapshot = await readDiffSnapshot(deps.database, scope, snapshotId)
  if (input.action === 'create') {
    if (input.anchor.snapshotId !== snapshotId || input.anchor.sourceVersion !== snapshot.revision.version)
      throw new WorkspaceReviewError('workspace_review_anchor_invalid')
    const patch = await diffFile(deps, actor, runId, repoId, snapshotId, input.anchor.path, signal)
    validateReviewAnchor(input.anchor, patch)
  }
  const fingerprint = diffDigest(JSON.stringify([snapshotId, input]))
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (client, fresh) => {
    const { rows: [board] } = await client.query<{ revision: number }>('SELECT revision FROM coding_workspace_review_boards WHERE id=$1 FOR UPDATE', [fresh.boardId])
    if (!board) throw new WorkspaceReviewError('workspace_review_unavailable')
    const { rows: [prior] } = await client.query<{ fingerprint: string; response: ReviewMutationReceipt }>(
      'SELECT fingerprint,response FROM coding_workspace_review_receipts WHERE "boardId"=$1 AND "userId"=$2 AND "requestId"=$3', [fresh.boardId, actor.userId, input.requestId])
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new WorkspaceReviewError('workspace_review_conflict')
      return prior.response
    }
    const masks = await Promise.all([
      secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: fresh.identity.ownerId }),
      secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId }),
    ])
    const maskBody = (body: string) => {
      const text = masks.reduce((text, mask) => mask(text), body)
      if (text.length > 4000) throw new CodingWorkspaceError('workspace_limit_exceeded')
      return text
    }
    if (board.revision !== input.expectedRevision) throw new WorkspaceReviewError('workspace_review_conflict')
    const requests = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_review_receipts WHERE "boardId"=$1', [fresh.boardId])
    if (requests.rows[0]!.count >= 50_000) throw new CodingWorkspaceError('workspace_limit_exceeded')
    if (input.action === 'create' || input.action === 'reply') {
      const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_review_comments WHERE "boardId"=$1', [fresh.boardId])
      if (count.rows[0]!.count >= 10_000) throw new CodingWorkspaceError('workspace_limit_exceeded')
    }
    const response: ReviewMutationReceipt = { requestId: input.requestId, action: input.action, revision: board.revision + 1 }
    if (input.action === 'create') {
      const stored = await readStoredDiffFile(client, fresh, snapshot, input.anchor.path, masks[0]!)
      if (!stored.patch) throw new WorkspaceReviewError('workspace_review_anchor_invalid')
      const anchor = validateReviewAnchor(input.anchor, stored.patch)
      const id = randomUUID()
      await client.query(`INSERT INTO coding_workspace_review_comments (id,"boardId","threadId","snapshotId","userId",anchor,body,draft)
        VALUES ($1,$2,$1,$3,$4,$5,$6,$7)`, [id, fresh.boardId, snapshotId, actor.userId, anchor, maskBody(input.body), input.draft])
      response.commentId = id; response.threadId = id
    } else if (input.action === 'reviewed') {
      if (new Set(input.files.map(file => file.path)).size !== input.files.length) throw new CodingWorkspaceError('workspace_invalid_request')
      const { rows } = await client.query<{ path: string; fileVersion: string }>(`SELECT path,metadata->>'fileVersion' AS "fileVersion"
        FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND path=ANY($2::text[])`, [snapshotId, input.files.map(file => file.path)])
      if (rows.length !== input.files.length || input.files.some(file => !rows.some(row => row.path === file.path && row.fileVersion === file.fileVersion)))
        throw new WorkspaceReviewError('workspace_snapshot_outdated')
      for (const file of input.files) {
        if (file.reviewed) await client.query(`INSERT INTO coding_workspace_reviewed_files ("boardId","userId",path,"fileVersion") VALUES ($1,$2,$3,$4)
          ON CONFLICT ("boardId","userId",path) DO UPDATE SET "fileVersion"=EXCLUDED."fileVersion","reviewedAt"=clock_timestamp()`, [fresh.boardId, actor.userId, file.path, file.fileVersion])
        else await client.query('DELETE FROM coding_workspace_reviewed_files WHERE "boardId"=$1 AND "userId"=$2 AND path=$3 AND "fileVersion"=$4', [fresh.boardId, actor.userId, file.path, file.fileVersion])
      }
      response.changed = input.files.length
    } else {
      const id = input.action === 'edit' ? input.commentId : input.threadId
      const { rows: [comment] } = await client.query<{ id: string; threadId: string; snapshotId: string; userId: string; anchor: unknown; body: string; draft: boolean; resolved: boolean }>(
        `SELECT c.* FROM coding_workspace_review_comments c JOIN coding_workspace_review_comments root ON root.id=c."threadId"
          WHERE c.id=$1 AND c."boardId"=$2 AND (NOT c.draft OR c."userId"=$3) AND (NOT root.draft OR root."userId"=$3) FOR UPDATE OF c`,
        [id, fresh.boardId, actor.userId])
      if (!comment) throw new WorkspaceReviewError('workspace_review_unavailable')
      if (input.action === 'reply') {
        if (comment.id !== comment.threadId) throw new WorkspaceReviewError('workspace_review_unavailable')
        const id = randomUUID()
        await client.query(`INSERT INTO coding_workspace_review_comments (id,"boardId","threadId","snapshotId","userId",anchor,body,draft)
          VALUES ($1,$2,$3,$4,$5,$6,$7,false)`, [id, fresh.boardId, comment.threadId, comment.snapshotId, actor.userId, comment.anchor, maskBody(input.body)])
        response.commentId = id; response.threadId = comment.threadId
      } else if (input.action === 'edit') {
        if (comment.userId !== actor.userId) throw new WorkspaceReviewError('workspace_review_unavailable')
        const body = maskBody(input.body)
        await client.query('UPDATE coding_workspace_review_comments SET body=$2,"updatedAt"=clock_timestamp() WHERE id=$1', [comment.id, body])
        response.commentId = comment.id; response.audit = { before: diffDigest(comment.body), after: diffDigest(body) }
      } else {
        if (comment.id !== comment.threadId || (comment.userId !== actor.userId && fresh.identity.ownerId !== actor.userId))
          throw new WorkspaceReviewError('workspace_review_unavailable')
        await client.query('UPDATE coding_workspace_review_comments SET resolved=$2,"updatedAt"=clock_timestamp() WHERE id=$1', [comment.id, input.resolved])
        response.threadId = comment.id; response.audit = { before: comment.resolved, after: input.resolved }
      }
    }
    await client.query('UPDATE coding_workspace_review_boards SET revision=revision+1,"updatedAt"=clock_timestamp() WHERE id=$1', [fresh.boardId])
    await client.query(`INSERT INTO coding_workspace_review_receipts ("boardId","userId","requestId",fingerprint,action,response)
      VALUES ($1,$2,$3,$4,$5,$6)`, [fresh.boardId, actor.userId, input.requestId, fingerprint, input.action, response])
    await runChanged(client, runId)
    if (input.action === 'create' || input.action === 'reply' || input.action === 'edit') {
      const currentMasks = await Promise.all([
        secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: fresh.identity.ownerId }),
        secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId }),
      ])
      if (masks.some((mask, index) => !mask.sourcePolicy || mask.sourcePolicy !== currentMasks[index]!.sourcePolicy))
        throw new CodingWorkspaceError('workspace_path_unavailable')
    }
    return response
  }, { signal })
}
