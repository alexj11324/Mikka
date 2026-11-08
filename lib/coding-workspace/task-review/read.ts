import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { diffSnapshot, reviewAnchor, taskReviewRef, WorkspaceReviewError, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { UNFINISHED_RUN_STATUSES } from '../../agent-run-statuses'
import { reviewMasks } from '../diff/batch-store'
import { associatedGitHubPull } from '../diff/github'
import { captureDiffSnapshot, diffFile } from '../diff/service'
import { latestDiffSnapshot, readDiffFilePage, readDiffSnapshot, readStoredDiffFile } from '../diff/store'
import type { ReviewActor, ReviewScope } from '../diff/authority'
import { assertCurrentTaskReview, currentTaskReview, selectedTaskReview } from './context'
import type { TaskReviewHttpInput, TaskReviewHttpResult } from './http'
import { projectTaskReviewSummary, reviewReference, taskReviewDiff, taskReviewFile, type TaskSummaryFacts } from './projection'
import { latestTaskReviewChecks } from './checks'
import { retainTaskPullState } from './pull-state'

export type { TaskReviewSummary, TaskSummaryChecks, TaskSummaryFacts } from './projection'

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const referenceQuery = { snapshotId: z.uuid().optional(), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() }
const pageQuery = z.strictObject({ workspaceId: z.uuid().optional(), ...referenceQuery,
  cursor: z.string().max(4096).optional(), commit: sha.optional(), unreviewed: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100) })
const fileQuery = z.strictObject({ workspaceId: z.uuid().optional(), ...taskReviewRef.shape,
  path: reviewAnchor.shape.path, cursor: z.string().max(4096).optional() })
const pageCursor = z.strictObject({ reviewRef: taskReviewRef, position: z.string().max(1024), unreviewed: z.boolean().default(false) })
const commentCursor = z.strictObject({ reviewRef: taskReviewRef, path: reviewAnchor.shape.path, id: z.uuid() })
const empty: TaskReviewHttpResult = { context: null, render: async () => ({ body: null }) }
function decode<T>(schema: z.ZodType<T>, value: string): T {
  try { return schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))) }
  catch (cause) { throw new CodingWorkspaceError('workspace_invalid_request', { cause }) }
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const running = (scope: ReviewScope) => !scope.stopped && UNFINISHED_RUN_STATUSES.some(status => status === scope.status)
export async function taskReviewSummary(tx: Pick<PoolClient, 'query'>, actor: ReviewActor, scope: ReviewScope, snapshot: DiffSnapshot | null) {
  const { rows: [facts] } = await tx.query<TaskSummaryFacts>(`SELECT p.branch,ps.observation AS "pullObservation",
    coalesce(m.state='ended' AND m."sandboxId" IS NULL,false) AS reclaimed,
    EXISTS(SELECT 1 FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
      WHERE t.id=$5::uuid AND t."issueId"=$3 AND t."userId"=$2 AND c.id=$6::uuid
        AND c.sha=$7 AND c."runId"=$8::uuid AND t.stage='approval' AND t.status IN ('pending','waiting')
        AND NOT EXISTS(SELECT 1 FROM factory_merges fm WHERE fm."taskId"=t.id AND fm.status IN ('merging','merged'))) AS "canMerge"
    ,EXISTS(SELECT 1 FROM factory_merges fm WHERE fm."taskId"=$5::uuid AND fm."candidateId"=$6::uuid AND fm.status IN ('merging','merged')) AS merging
    ,(SELECT jsonb_build_object('taskId',t.id,'issueId',t."issueId",'attemptId',t."attemptId",'revision',t.revision,'candidateId',t."candidateId")
      FROM factory_tasks t WHERE t.id=$5::uuid AND t."issueId"=$3 AND t."userId"=$2 AND t."candidateId"=$6::uuid) AS "mergeBinding"
    FROM agent_runs r LEFT JOIN run_publications p ON p."runId"=r.id AND p."userId"=r."userId"
      AND p."issueId"=r."issueId" AND p."remoteKey"=$4
    LEFT JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=r."userId" AND m."workspaceId"=$9
    LEFT JOIN coding_workspace_pull_states ps ON ps."snapshotId"=$10 AND ps."userId"=$11 AND ps."workspaceId"=$9
    WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$3`,
  [scope.identity.runId, scope.identity.ownerId, scope.taskId, scope.identity.repositoryKey, snapshot?.factory?.taskId ?? null,
    snapshot?.factory?.candidateId ?? null, snapshot?.factory?.sha ?? null, snapshot?.factory?.producerRunId ?? null, actor.workspaceId, snapshot?.id ?? null, actor.userId])
  const checks = snapshot && snapshot.availability !== 'unavailable'
    ? await latestTaskReviewChecks(tx, actor, scope, snapshot, await reviewMasks(actor, scope)) : null
  return projectTaskReviewSummary(actor, scope, snapshot, facts, checks)
}

/** Sent comments come from an accepted agent batch, not the mutable local
 * board or GitHub's separate delivery. Only this exact snapshot is inline. */
async function sentCounts(tx: Pick<PoolClient, 'query'>, scope: ReviewScope, snapshot: DiffSnapshot, paths: string[]) {
  const { rows } = await tx.query<{ path: string; count: number }>(`SELECT c->'anchor'->>'path' AS path,count(DISTINCT c->>'id')::int AS count
    FROM coding_workspace_review_batches b CROSS JOIN LATERAL jsonb_array_elements(b.input->'agent'->'comments') c
    WHERE b."boardId"=$1 AND b."snapshotId"=$2::uuid AND b.destination='agent' AND b.state='accepted'
      AND c->'anchor'->>'snapshotId'=$2::text AND c->'anchor'->>'sourceVersion'=$3 AND c->'anchor'->>'path'=ANY($4::text[])
    GROUP BY c->'anchor'->>'path'`, [scope.boardId, snapshot.id, snapshot.revision.version, paths])
  return new Map(rows.map(row => [row.path, row.count]))
}

export async function readTaskReview(input: TaskReviewHttpInput): Promise<TaskReviewHttpResult> {
  const { deps, actor, taskId, request } = input, query = pageQuery.parse(input.input)
  if (Boolean(query.snapshotId) !== Boolean(query.sourceVersion)) throw new CodingWorkspaceError('workspace_invalid_request')
  const after = query.cursor ? decode(pageCursor, query.cursor) : undefined
  const explicit = query.snapshotId ? taskReviewRef.parse({ snapshotId: query.snapshotId, sourceVersion: query.sourceVersion }) : undefined
  if (explicit && after && !isDeepStrictEqual(explicit, after.reviewRef)) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  if (after && query.commit) throw new CodingWorkspaceError('workspace_invalid_request')
  const unreviewed = query.unreviewed === undefined ? after?.unreviewed ?? false : query.unreviewed === 'true'
  if (after && after.unreviewed !== unreviewed) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  const reference = after?.reviewRef ?? explicit
  const context = reference ? await selectedTaskReview(deps, actor, taskId, reference, request.signal)
    : await currentTaskReview(deps, actor, taskId, request.signal)
  if (!context) return empty
  const { runId, repoId } = context.scope.identity
  const chosen = 'snapshot' in context ? diffSnapshot.parse(context.snapshot) : undefined
  let selected: DiffSnapshot
  if (query.commit) {
    if (!chosen?.revision.baseSha) throw new CodingWorkspaceError('workspace_invalid_request')
    selected = await captureDiffSnapshot(deps, actor, runId, repoId,
      { source: 'commit', baseSha: chosen.revision.baseSha, headSha: query.commit }, request.signal)
  } else if (chosen) selected = chosen
  else {
    let hasPull = false
    try { await associatedGitHubPull(deps.database, context.scope); hasPull = true }
    catch (error) { if (!(error instanceof WorkspaceReviewError) || error.code !== 'workspace_snapshot_unavailable') throw error }
    const retained = !hasPull && actor.userId !== context.ownerId ? await summarySnapshot(deps.database, context.scope) : null
    selected = retained ?? await captureDiffSnapshot(deps, actor, runId, repoId, { source: hasPull ? 'pull_request' : 'auto' }, request.signal)
  }
  // The existing provider rechecks the viewing person's native GitHub access
  // and current PR association before any retained metadata is returned.
  if (selected.sourceAccess || selected.pullRequest) {
    if (!deps.external) throw new WorkspaceReviewError('workspace_review_github_unavailable')
    const observation = await deps.external.verify(context.scope, selected)
    if (observation) selected = { ...selected, isStale: observation.isStale }
  }
  const pullState = selected.pullRequest && !selected.isStale ? await deps.external?.pullState?.(context.scope, selected) : undefined
  return { context, render: async (tx, scope) => {
    const snapshot = selected.availability === 'unavailable' ? selected : {
      ...await readDiffSnapshot(tx, scope, selected.id), observedAt: selected.observedAt, isStale: selected.isStale,
    }
    const page = snapshot.availability === 'unavailable' ? { files: [], nextCursor: null, boardRevision: null }
      : await readDiffFilePage(tx, scope, snapshot, actor.userId, { cursor: after?.position, limit: query.limit, unreviewed })
    await retainTaskPullState(tx, actor, scope, snapshot, pullState)
    const counts = await sentCounts(tx, scope, snapshot, page.files.map(file => file.path))
    const { rows } = await tx.query<{ path: string; known: boolean }>(`SELECT path,coalesce(patch->>'format' IN ('text','binary'),false) AS known
      FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND path=ANY($2::text[])`, [snapshot.id, page.files.map(file => file.path)])
    const known = new Map(rows.map(row => [row.path, row.known]))
    const summary = await taskReviewSummary(tx, actor, scope, snapshot.revision.source === 'commit' ? await summarySnapshot(tx, scope) : snapshot)
    const files = page.files.map(file => taskReviewFile(file, { reviewed: file.reviewed, countsKnown: known.get(file.path) ?? false, comments: counts.get(file.path) ?? 0 }))
    return { body: { summary, diff: { ...taskReviewDiff(snapshot, files, { running: summary.running, reclaimed: summary.reclaimed,
      nextCursor: page.nextCursor ? encode({ reviewRef: reviewReference(snapshot), position: page.nextCursor, unreviewed }) : null }), boardRevision: page.boardRevision } } }
  } }
}

export async function readTaskReviewSummary(input: TaskReviewHttpInput): Promise<TaskReviewHttpResult> {
  z.strictObject({ workspaceId: z.uuid().optional() }).parse(input.input)
  const context = await currentTaskReview(input.deps, input.actor, input.taskId, input.request.signal)
  if (!context) return empty
  const selected = await summarySnapshot(input.deps.database, context.scope)
  if (selected?.sourceAccess || selected?.pullRequest) {
    if (!input.deps.external) throw new WorkspaceReviewError('workspace_review_github_unavailable')
    await input.deps.external.verify(context.scope, selected)
  }
  const pullState = selected?.pullRequest ? await input.deps.external?.pullState?.(context.scope, selected) : undefined
  return { context, render: async (tx, scope) => {
    await assertCurrentTaskReview(tx, input.actor, context)
    const current = await summarySnapshot(tx, scope)
    if (current?.id !== selected?.id) throw new WorkspaceReviewError('workspace_snapshot_outdated')
    if (current) await retainTaskPullState(tx, input.actor, scope, current, pullState)
    return { body: await taskReviewSummary(tx, input.actor, scope, current) }
  } }
}

/** Commit filters never replace the Task's whole-review summary. A failed
 * latest checkpoint cannot silently fall back to an older successful one. */
export async function summarySnapshot(tx: Pick<PoolClient, 'query'>, scope: ReviewScope): Promise<DiffSnapshot | null> {
  try {
    const associated = await associatedGitHubPull(tx, scope)
    const { rows: [pull] } = await tx.query<{ id: string }>(`SELECT id FROM coding_workspace_snapshots
      WHERE "runId"=$1 AND "repoId"=$2 AND "workspaceId"=$3 AND source='pull_request'
        AND snapshot->'pullRequest'->>'number'=$4 AND coalesce(snapshot->'factory','null'::jsonb)=$5::jsonb
      ORDER BY "createdAt" DESC,id DESC LIMIT 1`, [scope.identity.runId, scope.identity.repoId, scope.identity.workspaceId,
      String(associated.number), JSON.stringify(associated.factory ?? null)])
    if (pull) return readDiffSnapshot(tx, scope, pull.id)
  } catch (error) { if (!(error instanceof WorkspaceReviewError) || error.code !== 'workspace_snapshot_unavailable') throw error }
  if (running(scope)) return latestDiffSnapshot(tx, scope, 'working')
  const { rows: [checkpoint] } = await tx.query<{ snapshotId: string | null; reason: string | null }>(`SELECT "snapshotId",reason FROM coding_workspace_checkpoint_reviews
    WHERE "runId"=$1 AND "repoId"=$2 AND "workspaceId"=$3`, [scope.identity.runId, scope.identity.repoId, scope.identity.workspaceId])
  return checkpoint?.snapshotId && !checkpoint.reason ? readDiffSnapshot(tx, scope, checkpoint.snapshotId) : null
}

export async function readTaskReviewFile(input: TaskReviewHttpInput): Promise<TaskReviewHttpResult> {
  const { deps, actor, taskId, request } = input, query = fileQuery.parse(input.input)
  const reference = taskReviewRef.parse({ snapshotId: query.snapshotId, sourceVersion: query.sourceVersion })
  const context = await selectedTaskReview(deps, actor, taskId, reference, request.signal)
  const after = query.cursor ? decode(commentCursor, query.cursor) : undefined
  if (after && (!isDeepStrictEqual(after.reviewRef, reference) || after.path !== query.path)) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  const loaded = await diffFile(deps, actor, context.scope.identity.runId, context.scope.identity.repoId, context.snapshot.id, query.path, request.signal)
  return { context, render: async (tx, scope) => {
    const snapshot = await readDiffSnapshot(tx, scope, context.snapshot.id), masks = await reviewMasks(actor, scope)
    const stored = await readStoredDiffFile(tx, scope, snapshot, query.path, masks[0]!)
    const { rows } = await tx.query<{ id: string; anchor: unknown; body: string; author: string; sentAt: Date }>(`SELECT * FROM (
      SELECT DISTINCT ON (c->>'id') (c->>'id')::uuid AS id,c->'anchor' AS anchor,c->>'body' AS body,
        coalesce(u.name,b."userId") AS author,b."updatedAt" AS "sentAt"
      FROM coding_workspace_review_batches b CROSS JOIN LATERAL jsonb_array_elements(b.input->'agent'->'comments') c
      LEFT JOIN "user" u ON u.id=b."userId"
      WHERE b."boardId"=$1 AND b."snapshotId"=$2::uuid AND b.destination='agent' AND b.state='accepted'
        AND c->'anchor'->>'snapshotId'=$2::text AND c->'anchor'->>'sourceVersion'=$3 AND c->'anchor'->>'path'=$4
      ORDER BY c->>'id',b."updatedAt",b.id
    ) sent WHERE ($5::uuid IS NULL OR id>$5::uuid) ORDER BY id LIMIT 101`,
    [scope.boardId, snapshot.id, snapshot.revision.version, query.path, after?.id ?? null])
    const comments = rows.slice(0, 100).map(row => {
      const anchor = reviewAnchor.parse(row.anchor)
      return { id: row.id, path: anchor.path, line: anchor.lineEnd, side: anchor.side === 'LEFT' ? 'old' : 'new',
        body: masks.reduce((body, mask) => mask(body), row.body), author: row.author, sentAt: row.sentAt.toISOString() }
    })
    const counts = await sentCounts(tx, scope, snapshot, [query.path])
    const { rows: [viewed] } = await tx.query(`SELECT 1 FROM coding_workspace_reviewed_files
      WHERE "boardId"=$1 AND "userId"=$2 AND path=$3 AND "fileVersion"=$4`,
    [scope.boardId, actor.userId, query.path, stored.file.fileVersion])
    return { sourcePolicy: masks[0]!.sourcePolicy, body: { reviewRef: reference,
      file: taskReviewFile(stored.file, { patch: stored.patch ?? (loaded.format === 'unavailable' ? loaded : null),
        reviewed: Boolean(viewed), comments: counts.get(query.path) ?? 0 }), comments,
      ...(rows.length > 100 ? { nextCommentsCursor: encode({ reviewRef: reference, path: query.path, id: rows[99]!.id }) } : {}) } }
  } }
}
