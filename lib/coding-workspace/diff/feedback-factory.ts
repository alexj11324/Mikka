import 'server-only'
import type { PoolClient } from 'pg'
import { WorkspaceReviewError, type DiffSnapshot, type ReviewBatchRequest } from '@mikka/protocol/coding-workspace-review'
import type { FactoryTask } from '../../factory/store'
import { lockFactoryCompletionTasks } from '../../run-completion-effects'
import { lockFactoryHostDispatch } from '../../factory/task-dispatch'
import { lockCliAgentPolicy } from '../../agent-tool-approval/policy-store'
import type { FrozenReviewBatch } from './batch-store'
import type { ReviewScope } from './authority'
import { UNFINISHED_RUN_STATUSES } from '../../agent-run-statuses'
import { normalizeRepository } from '@mikka/protocol/repository'

type FrozenFactory = NonNullable<NonNullable<FrozenReviewBatch['agent']>['factory']>
const outdated = () => new WorkspaceReviewError('workspace_snapshot_outdated')

async function sourceFactory(tx: PoolClient, scope: ReviewScope) {
  const { rows } = await tx.query<FactoryTask>(`SELECT t.* FROM factory_tasks t WHERE t."userId"=$2 AND t."issueId"=$3
    AND (EXISTS(SELECT 1 FROM factory_attempts a WHERE a."taskId"=t.id AND a."runId"=$1)
      OR EXISTS(SELECT 1 FROM factory_candidates c WHERE c."taskId"=t.id AND c."runId"=$1))`,
  [scope.identity.runId, scope.identity.ownerId, scope.taskId])
  if (rows.length > 1) throw outdated()
  return rows[0]
}

export async function currentReviewFactory(tx: PoolClient, scope: ReviewScope): Promise<ReviewBatchRequest['factory']> {
  const task = await sourceFactory(tx, scope)
  return task ? { taskId: task.id, revision: task.revision, attemptId: task.attemptId,
    candidateId: task.candidateId, sourceEventId: task.sourceEventId } : undefined
}

/** Freeze the requested original tuple from retained host history. Current
 * lifecycle equality is checked only before a new effect, so a new request ID
 * can still dedupe an already accepted batch after the task has advanced. */
export async function freezeReviewFactory(tx: PoolClient, scope: ReviewScope, snapshot: DiffSnapshot,
  expected: ReviewBatchRequest['factory']): Promise<FrozenFactory | undefined> {
  const task = await sourceFactory(tx, scope)
  if (!task && !expected) return undefined
  if (!task || !expected || task.id !== expected.taskId) throw outdated()
  const { rows: [attempt] } = await tx.query<{ id: string; runId: string | null }>('SELECT id,"runId" FROM factory_attempts WHERE id=$1 AND "taskId"=$2', [expected.attemptId, task.id])
  if (!attempt) throw outdated()
  if (!expected.candidateId) {
    if (attempt.runId !== scope.identity.runId) throw outdated()
    return { ...expected, producerRunId: scope.identity.runId, sha: snapshot.revision.headSha }
  }
  const { rows: [candidate] } = await tx.query<{ runId: string; sha: string; repository: string; kind: string; sourceMatches: boolean }>(
    `SELECT c."runId",c.sha,c.repository,c.kind,
      (c."runId"=$3 OR EXISTS(SELECT 1 FROM factory_attempts a WHERE a."taskId"=c."taskId" AND a."runId"=$3 AND a."candidateId"=c.id)) AS "sourceMatches"
      FROM factory_candidates c WHERE c.id=$1 AND c."taskId"=$2
        AND NOT EXISTS(SELECT 1 FROM improvement_skill_candidates skill WHERE skill."candidateId"=c.id)`,
  [expected.candidateId, task.id, scope.identity.runId])
  if (!candidate || !candidate.sourceMatches || candidate.kind !== 'repository' || candidate.sha !== snapshot.revision.headSha
    || (snapshot.factory && (snapshot.factory.taskId !== task.id || snapshot.factory.candidateId !== expected.candidateId
      || snapshot.factory.producerRunId !== candidate.runId || snapshot.factory.sha !== candidate.sha))) throw outdated()
  let repository: string
  try { repository = candidate.repository.startsWith('v2/') ? candidate.repository
    : normalizeRepository(/^[\w.-]+\/[\w.-]+$/.test(candidate.repository)
      ? `https://github.com/${candidate.repository}.git` : candidate.repository, { allowFile: true }).key }
  // error-cause: repository parser errors can quote credential-bearing remote URLs.
  catch { throw outdated() }
  if (repository !== scope.identity.repositoryKey) throw outdated()
  return { ...expected, producerRunId: candidate.runId, sha: candidate.sha }
}

export async function assertFeedbackFactory(tx: PoolClient, scope: ReviewScope, expected: FrozenFactory | undefined) {
  const task = await sourceFactory(tx, scope)
  if (!task && !expected) return undefined
  if (!task || !expected || task.id !== expected.taskId || task.revision !== expected.revision
    || task.attemptId !== expected.attemptId || task.candidateId !== expected.candidateId || task.sourceEventId !== expected.sourceEventId)
    throw outdated()
  // A durable merge claim already owns the candidate. A repair cannot race
  // its provider effect or move the Task between PUT and receipt settlement.
  if (task.candidateId && (await tx.query(`SELECT 1 FROM factory_merges WHERE "taskId"=$1 AND "candidateId"=$2
    AND status IN ('merging','merged')`, [task.id, task.candidateId])).rowCount) throw outdated()
  return task
}

/** The same task-thread/admission locks precede Task, issue, Run and board.
 * A live message locks its Run for update before acquiring the review board. */
export async function lockReviewFeedbackTarget(tx: PoolClient, scope: ReviewScope) {
  const ownerId = scope.identity.ownerId, runId = scope.identity.runId
  if (scope.taskId) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['task-thread', ownerId, scope.taskId])])
    await lockFactoryHostDispatch(tx, ownerId, scope.taskId)
  }
  const { rows: [run] } = await tx.query<{ agentId: string; botId: string | null }>(`SELECT r."agentId",CASE WHEN f.id IS NOT NULL THEN f."botId" ELSE r."botId" END AS "botId"
    FROM agent_runs r LEFT JOIN LATERAL (SELECT t.id,t."botId" FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
      WHERE a."runId"=r.id AND t."userId"=r."userId" LIMIT 1) f ON true WHERE r.id=$1 AND r."userId"=$2`, [runId, ownerId])
  if (!run) throw outdated()
  if (!UNFINISHED_RUN_STATUSES.some(status => status === scope.status)) await lockCliAgentPolicy(tx, ownerId, run.agentId, run.botId)
  if (scope.taskId) await tx.query('SELECT id FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2 ORDER BY id FOR UPDATE', [ownerId, scope.taskId])
  await lockFactoryCompletionTasks(tx, ownerId, runId)
}
