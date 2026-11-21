import 'server-only'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { reviewAttachedCheck, taskReviewRef, WorkspaceReviewError, type DiffSnapshot, type ReviewAttachedCheck } from '@mikka/protocol/coding-workspace-review'
import { runChanged } from '../../live/panels'
import { maskDeep, type Masker } from '../../secrets/mask'
import { assertBatchMaskPolicy, lockReviewBoard, reviewMasks } from '../diff/batch-store'
import type { ReviewActor, ReviewScope } from '../diff/authority'
import { associatedGitHubPull, readGitHubPull } from '../diff/github'
import { nativeReviewUserGrant } from '../diff/github-write'
import { selectedTaskReview } from './context'
import { reviewReference } from './projection'
import { observedReviewChecks, readNativeReviewChecks, type ObservedReviewChecks } from './github-checks'
import type { TaskReviewHttpInput, TaskReviewHttpResult } from './http'

type Query = Pick<PoolClient, 'query'>
type ObservationRow = { id: string; snapshotId: string; maskPolicy: string; viewerMaskPolicy: string; observation: unknown }
const querySchema = z.strictObject({ workspaceId: z.uuid().optional(), ...taskReviewRef.shape })
const checkRef = /^github-check:([a-f0-9-]{36}):(check_run|commit_status):([1-9]\d{0,39})$/
const unavailable = () => new WorkspaceReviewError('workspace_review_unavailable')
function parseObservation(row: ObservationRow, snapshot: DiffSnapshot, masks: Masker[]) {
  const observation = observedReviewChecks.parse(row.observation)
  if (row.snapshotId !== snapshot.id || observation.headSha !== snapshot.revision.headSha
    || observation.repositoryId !== snapshot.sourceAccess?.repositoryId) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  if (!masks[0]?.sourcePolicy || !masks[1]?.sourcePolicy || row.maskPolicy !== masks[0].sourcePolicy || row.viewerMaskPolicy !== masks[1].sourcePolicy
    || masks.some(mask => !isDeepStrictEqual(maskDeep(observation, mask), observation))) throw new CodingWorkspaceError('workspace_path_unavailable')
  return observation
}
const publicCheck = (rowId: string, check: ObservedReviewChecks['checks'][number]) => ({
  id: `github-check:${rowId}:${check.kind}:${check.nativeId}`, name: check.name, nameTruncated: check.nameTruncated,
  status: check.status, conclusion: check.conclusion, logExcerpt: check.logExcerpt, logTruncated: check.logTruncated,
  ...(check.logUrl ? { logUrl: check.logUrl } : {}),
})

export async function latestTaskReviewChecks(tx: Query, actor: ReviewActor, scope: ReviewScope, snapshot: DiffSnapshot, masks: Masker[]) {
  const { rows: [row] } = await tx.query<ObservationRow>(`SELECT id,"snapshotId","maskPolicy","viewerMaskPolicy",observation
    FROM coding_workspace_check_observations WHERE "boardId"=$1 AND "snapshotId"=$2 AND "userId"=$3 AND "workspaceId"=$4
    ORDER BY "createdAt" DESC,id DESC LIMIT 1`, [scope.boardId, snapshot.id, actor.userId, actor.workspaceId])
  if (!row) return null
  const observation = parseObservation(row, snapshot, masks)
  return { ...observation.counts, sha: observation.headSha, observedAt: observation.observedAt, fingerprint: observation.fingerprint }
}

/** Complete failed-check evidence is frozen into the same agent batch. A
 * client supplies only native observation references, never log text. */
export async function freezeAttachedReviewChecks(tx: Query, actor: ReviewActor, scope: ReviewScope, snapshot: DiffSnapshot,
  references: string[], masks: Masker[]): Promise<ReviewAttachedCheck[]> {
  if (new Set(references).size !== references.length) throw new CodingWorkspaceError('workspace_invalid_request')
  const parsed = references.map(reference => {
    const value = checkRef.exec(reference)
    if (!value || !z.uuid().safeParse(value[1]).success) throw new CodingWorkspaceError('workspace_invalid_request')
    return { reference, id: value[1]!, kind: value[2]!, nativeId: value[3]! }
  })
  if (!parsed.length) return []
  const { rows } = await tx.query<ObservationRow>(`SELECT id,"snapshotId","maskPolicy","viewerMaskPolicy",observation
    FROM coding_workspace_check_observations WHERE id=ANY($1::uuid[]) AND "boardId"=$2 AND "snapshotId"=$3
      AND "userId"=$4 AND "workspaceId"=$5 FOR SHARE`,
  [[...new Set(parsed.map(item => item.id))], scope.boardId, snapshot.id, actor.userId, actor.workspaceId])
  const observations = new Map(rows.map(row => [row.id, parseObservation(row, snapshot, masks)]))
  return parsed.map(item => {
    const observation = observations.get(item.id), check = observation?.checks.find(check => check.kind === item.kind && check.nativeId === item.nativeId)
    if (!check || check.status !== 'failed') throw unavailable()
    return reviewAttachedCheck.parse({ id: item.reference, name: check.name, status: 'failed', headSha: observation!.headSha,
      logExcerpt: check.logExcerpt, logTruncated: check.logTruncated })
  }).sort((a, b) => a.id.localeCompare(b.id))
}

export async function readTaskReviewChecks(input: TaskReviewHttpInput): Promise<TaskReviewHttpResult> {
  const { deps, actor, taskId, request } = input, query = querySchema.parse(input.input)
  const reference = taskReviewRef.parse({ snapshotId: query.snapshotId, sourceVersion: query.sourceVersion })
  const context = await selectedTaskReview(deps, actor, taskId, reference, request.signal), snapshot = context.snapshot
  if (!snapshot.sourceAccess || !snapshot.revision.headSha) return { context, render: async () => ({
    body: { reviewRef: reference, state: 'not_applicable', checks: [], counts: null, observedAt: null },
  }) }
  const masks = await reviewMasks(actor, context.scope)
  const grant = await nativeReviewUserGrant(actor.userId, context.scope.identity.repositoryKey, snapshot.sourceAccess.repositoryId,
    { deadline: Date.now() + 25_000, signal: request.signal })
  const verify = async () => {
    if (!snapshot.pullRequest) return
    const current = await readGitHubPull(grant, snapshot.pullRequest.number)
    if (current.head.sha !== snapshot.revision.headSha || current.base.sha !== snapshot.pullRequest.baseSha)
      throw new WorkspaceReviewError('workspace_snapshot_outdated')
  }
  await verify()
  const observation = await readNativeReviewChecks(grant, snapshot.revision.headSha, masks)
  await verify()
  return { context, render: async (tx, scope) => {
    if (!grant.verifyCredential) throw unavailable()
    await grant.verifyCredential(tx)
    if (snapshot.pullRequest) {
      const associated = await associatedGitHubPull(tx, scope)
      if (associated.number !== snapshot.pullRequest.number || !isDeepStrictEqual(associated.factory, snapshot.factory))
        throw new WorkspaceReviewError('workspace_snapshot_outdated')
    }
    await lockReviewBoard(tx, scope)
    await assertBatchMaskPolicy(actor, scope, masks)
    const { rows: [prior] } = await tx.query<{ id: string }>(`SELECT id FROM coding_workspace_check_observations WHERE "snapshotId"=$1
      AND "userId"=$2 AND fingerprint=$3 AND "maskPolicy"=$4 AND "viewerMaskPolicy"=$5`,
    [snapshot.id, actor.userId, observation.fingerprint, masks[0]!.sourcePolicy, masks[1]!.sourcePolicy])
    let id = prior?.id
    if (!id) {
      if ((await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_check_observations WHERE "boardId"=$1 AND "userId"=$2',
        [scope.boardId, actor.userId])).rows[0]!.count >= 250) throw new CodingWorkspaceError('workspace_limit_exceeded')
      if ((await tx.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify(observation)])).rows[0]!.bytes > 262_144)
        throw new CodingWorkspaceError('workspace_limit_exceeded')
      id = randomUUID()
      await tx.query(`INSERT INTO coding_workspace_check_observations (id,"boardId","snapshotId","workspaceId","userId",fingerprint,"maskPolicy","viewerMaskPolicy",observation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, scope.boardId, snapshot.id, actor.workspaceId, actor.userId,
        observation.fingerprint, masks[0]!.sourcePolicy, masks[1]!.sourcePolicy, observation])
      await runChanged(tx, scope.identity.runId)
    }
    return { maskPolicies: masks.map(mask => mask.sourcePolicy!), body: { reviewRef: reviewReference(snapshot), observationId: id, state: 'complete',
      observedAt: observation.observedAt, headSha: observation.headSha, fingerprint: observation.fingerprint, counts: observation.counts,
      checks: observation.checks.map(check => publicCheck(id!, check)) } }
  } }
}
