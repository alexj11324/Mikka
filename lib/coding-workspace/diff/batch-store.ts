import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { reviewAnchor, reviewAttachedCheck, reviewBatchReceipt, type DiffSnapshot, type ReviewBatchReceipt, WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { secretMaskerFor } from '../../secrets/runtime'
import { maskDeep, type Masker } from '../../secrets/mask'
import { runChanged } from '../../live/panels'
import { diffDigest, validateReviewAnchor } from './patch'
import type { ReviewActor, ReviewScope } from './authority'
import { readStoredDiffFile } from './store'
import { nativeReviewWrite } from './github-write'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const frozenReviewBatch = z.strictObject({
  version: z.literal(1), sourceVersion: digest, runId: z.uuid(), repoId: z.uuid(), commentIds: z.array(z.uuid()).max(50),
  native: z.strictObject({ githubAccountId: z.string().regex(/^[1-9]\d{0,39}$/), write: nativeReviewWrite }).optional(),
  agent: z.strictObject({ text: z.string().min(1).max(10_000),
    comments: z.array(z.strictObject({ id: z.uuid(), anchor: reviewAnchor, body: z.string().max(4000) })).max(50),
    note: z.string().max(4000), failedCheckRefs: z.array(z.string().max(2000)).max(100), failedChecks: z.array(reviewAttachedCheck).max(100).optional(), factory: z.strictObject({ taskId: z.uuid(),
    revision: z.number().int().positive(), attemptId: z.uuid(), candidateId: z.uuid().nullable(), sourceEventId: z.uuid(),
    producerRunId: z.uuid(), sha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).nullable() }).optional() }).optional(),
}).refine(value => Boolean(value.native) !== Boolean(value.agent))
export type FrozenReviewBatch = z.infer<typeof frozenReviewBatch>
export type ReviewBatchRow = { id: string; boardId: string; snapshotId: string; userId: string; fingerprint: string;
  destination: 'agent' | 'github'; state: ReviewBatchReceipt['state']; input: FrozenReviewBatch; receipt: ReviewBatchReceipt | null }
export type FrozenReviewComment = { id: string; anchor: z.infer<typeof reviewAnchor>; body: string }
const conflict = () => new WorkspaceReviewError('workspace_review_conflict')

export async function reviewMasks(actor: ReviewActor, scope: ReviewScope) {
  return Promise.all([secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: scope.identity.ownerId }),
    secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })])
}
export function maskedReviewText(text: string, masks: Masker[], limit: number) {
  const value = masks.reduce((body, mask) => mask(body), text)
  if (value.length > limit) throw new CodingWorkspaceError('workspace_limit_exceeded')
  return value
}
export async function assertBatchMaskPolicy(actor: ReviewActor, scope: ReviewScope, expected: Masker[]) {
  const current = await reviewMasks(actor, scope)
  if (expected.some((mask, index) => !mask.sourcePolicy || mask.sourcePolicy !== current[index]!.sourcePolicy))
    throw new CodingWorkspaceError('workspace_path_unavailable')
}
export function assertBatchSafe(input: FrozenReviewBatch, masks: Masker[]) {
  if (masks.some(mask => !isDeepStrictEqual(maskDeep(input, mask), input))) throw new CodingWorkspaceError('workspace_path_unavailable')
}

export async function readReviewBatch(client: Pick<PoolClient, 'query'>, actor: ReviewActor, scope: ReviewScope, id: string): Promise<ReviewBatchRow> {
  const { rows: [row] } = await client.query<ReviewBatchRow>('SELECT * FROM coding_workspace_review_batches WHERE id=$1 AND "boardId"=$2 AND "userId"=$3',
    [z.uuid().parse(id), scope.boardId, actor.userId])
  if (!row) throw new WorkspaceReviewError('workspace_review_unavailable')
  row.input = frozenReviewBatch.parse(row.input)
  if (row.input.runId !== scope.identity.runId || row.input.repoId !== scope.identity.repoId) throw conflict()
  return row
}

/** Call with the board locked, after current Task/session/Workspace authority.
 * A frozen batch includes complete selected comments; never a truncated set. */
export async function freezeReviewComments(client: PoolClient, actor: ReviewActor, scope: ReviewScope, snapshot: DiffSnapshot,
  ids: string[], masks: Masker[]): Promise<FrozenReviewComment[]> {
  if (new Set(ids).size !== ids.length) throw new CodingWorkspaceError('workspace_invalid_request')
  if (!ids.length) return []
  const { rows } = await client.query<{ id: string; snapshotId: string; anchor: unknown; body: string }>(
    `SELECT c.id,c."snapshotId",c.anchor,c.body FROM coding_workspace_review_comments c
      JOIN coding_workspace_review_comments root ON root.id=c."threadId" AND root."boardId"=c."boardId"
      WHERE c.id=ANY($1::uuid[]) AND c."boardId"=$2 AND (NOT c.draft OR c."userId"=$3) AND (NOT root.draft OR root."userId"=$3)
      ORDER BY c.id FOR SHARE OF c,root`, [ids, scope.boardId, actor.userId])
  if (rows.length !== ids.length) throw new WorkspaceReviewError('workspace_review_unavailable')
  const comments: FrozenReviewComment[] = []
  const files = new Map<string, Awaited<ReturnType<typeof readStoredDiffFile>>>()
  for (const row of rows) {
    const anchor = reviewAnchor.parse(row.anchor)
    if (row.snapshotId !== snapshot.id || anchor.snapshotId !== snapshot.id || anchor.sourceVersion !== snapshot.revision.version) throw new WorkspaceReviewError('workspace_snapshot_outdated')
    let stored = files.get(anchor.path)
    if (!stored) { stored = await readStoredDiffFile(client, scope, snapshot, anchor.path, masks[0]!); files.set(anchor.path, stored) }
    if (!stored.patch) throw new WorkspaceReviewError('workspace_review_anchor_invalid')
    validateReviewAnchor(anchor, stored.patch)
    if (snapshot.pullRequest && (!stored.file.github || stored.file.github.patchSha256 === null)) throw new WorkspaceReviewError('workspace_review_anchor_invalid')
    if (masks.some(mask => !isDeepStrictEqual(maskDeep(anchor, mask), anchor))) throw new CodingWorkspaceError('workspace_path_unavailable')
    comments.push({ id: row.id, anchor, body: maskedReviewText(row.body, masks, 4000) })
  }
  return comments
}

export async function lockReviewBoard(client: PoolClient, scope: ReviewScope) {
  const { rows: [board] } = await client.query<{ revision: number }>('SELECT revision FROM coding_workspace_review_boards WHERE id=$1 FOR UPDATE', [scope.boardId])
  if (!board) throw new WorkspaceReviewError('workspace_review_unavailable')
  return board
}

/** Existing request IDs bind the original exact command; semantic dedupe also
 * catches a second click with a new request/batch ID but identical frozen data. */
export async function priorReviewBatch(client: PoolClient, actor: ReviewActor, scope: ReviewScope, requestId: string, requestDigest: string) {
  const { rows: [prior] } = await client.query<{ fingerprint: string; response: { batchId?: string } }>(
    'SELECT fingerprint,response FROM coding_workspace_review_receipts WHERE "boardId"=$1 AND "userId"=$2 AND "requestId"=$3', [scope.boardId, actor.userId, requestId])
  if (!prior) return null
  if (prior.fingerprint !== requestDigest || !prior.response.batchId) throw conflict()
  return readReviewBatch(client, actor, scope, prior.response.batchId)
}

export async function insertReviewBatch(client: PoolClient, actor: ReviewActor, scope: ReviewScope, snapshot: DiffSnapshot,
  input: { id: string; requestId: string; requestDigest: string; expectedRevision: number; destination: ReviewBatchRow['destination']; frozen: FrozenReviewBatch },
  revision: number): Promise<ReviewBatchRow> {
  const frozen = frozenReviewBatch.parse(input.frozen), fingerprint = diffDigest(JSON.stringify([snapshot.id, input.destination, frozen]))
  const { rows: [size] } = await client.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify(frozen)])
  if (!size || size.bytes > 32_768) throw new CodingWorkspaceError('workspace_limit_exceeded')
  const { rows: [duplicate] } = await client.query<ReviewBatchRow>(`SELECT * FROM coding_workspace_review_batches
    WHERE "boardId"=$1 AND "userId"=$2 AND destination=$3 AND fingerprint=$4 AND state<>'rejected'`, [scope.boardId, actor.userId, input.destination, fingerprint])
  let row: ReviewBatchRow
  if (duplicate) row = await readReviewBatch(client, actor, scope, duplicate.id)
  else {
    if (revision !== input.expectedRevision) throw conflict()
    const { rows: [count] } = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_review_batches WHERE "boardId"=$1', [scope.boardId])
    if (!count || count.count >= 10_000) throw new CodingWorkspaceError('workspace_limit_exceeded')
    const created = await client.query<ReviewBatchRow>(`INSERT INTO coding_workspace_review_batches
      (id,"boardId","snapshotId","userId",fingerprint,destination,state,input)
      VALUES ($1,$2,$3,$4,$5,$6,'prepared',$7) ON CONFLICT (id) DO NOTHING RETURNING *`,
    [input.id, scope.boardId, snapshot.id, actor.userId, fingerprint, input.destination, frozen])
    if (!created.rows[0]) throw conflict()
    row = created.rows[0]
  }
  const { rows: [requests] } = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_review_receipts WHERE "boardId"=$1', [scope.boardId])
  if (!requests || requests.count >= 50_000) throw new CodingWorkspaceError('workspace_limit_exceeded')
  await client.query(`INSERT INTO coding_workspace_review_receipts ("boardId","userId","requestId",fingerprint,action,response)
    VALUES ($1,$2,$3,$4,$5,$6)`, [scope.boardId, actor.userId, input.requestId, input.requestDigest,
    `batch_${input.destination}`, { batchId: row.id }])
  await client.query('UPDATE coding_workspace_review_boards SET revision=revision+1,"updatedAt"=clock_timestamp() WHERE id=$1', [scope.boardId])
  await runChanged(client, scope.identity.runId)
  return row
}

export async function batchReceipt(client: Pick<PoolClient, 'query'>, scope: ReviewScope, row: ReviewBatchRow): Promise<ReviewBatchReceipt> {
  const { rows: [board] } = await client.query<{ revision: number }>('SELECT revision FROM coding_workspace_review_boards WHERE id=$1', [scope.boardId])
  if (!board) throw new WorkspaceReviewError('workspace_review_unavailable')
  return reviewBatchReceipt.parse({ batchId: row.id, destination: row.destination, state: row.state,
    sourceVersion: row.input.sourceVersion, revision: board.revision, delivery: row.receipt?.delivery ?? null,
    ...(row.receipt?.reason ? { reason: row.receipt.reason } : {}) })
}

export async function settleReviewBatch(client: PoolClient, scope: ReviewScope, row: ReviewBatchRow,
  state: 'accepted' | 'rejected' | 'uncertain', delivery: ReviewBatchReceipt['delivery'], reason?: ReviewBatchReceipt['reason']): Promise<ReviewBatchReceipt> {
  if ((state === 'accepted') !== (delivery !== null)) throw conflict()
  const { rows: [board] } = await client.query<{ revision: number }>('UPDATE coding_workspace_review_boards SET revision=revision+1,"updatedAt"=clock_timestamp() WHERE id=$1 RETURNING revision', [scope.boardId])
  if (!board) throw new WorkspaceReviewError('workspace_review_unavailable')
  const receipt = reviewBatchReceipt.parse({ batchId: row.id, destination: row.destination, state, sourceVersion: row.input.sourceVersion,
    revision: board.revision, delivery, ...(reason ? { reason } : {}) })
  if (!(await client.query(`UPDATE coding_workspace_review_batches SET state=$2,receipt=$3,"updatedAt"=clock_timestamp()
    WHERE id=$1 AND state IN ('prepared','delivering','uncertain')`, [row.id, state, receipt])).rowCount) throw conflict()
  if (state === 'accepted' && row.input.commentIds.length) await client.query(`UPDATE coding_workspace_review_comments SET draft=false,"updatedAt"=clock_timestamp()
    WHERE "boardId"=$1 AND id=ANY($2::uuid[]) AND "userId"=$3`, [scope.boardId, row.input.commentIds, row.userId])
  await runChanged(client, scope.identity.runId)
  return receipt
}
