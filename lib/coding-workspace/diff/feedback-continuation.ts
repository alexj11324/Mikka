import 'server-only'
import type { PoolClient } from 'pg'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import type { WorkerDefinitionSnapshot } from '../../agent-kit/worker'
import { queueFactoryRun } from '../../agent-runs'
import { latestTaskRun } from '../../thread-dispatch'
import { readRunChain } from '../../run-chain'
import { threadRunModel } from '../../computer/run-model'
import { ensureRecordedBotHarnessRuntime } from '../../computer/bot-runtime-records'
import { queueCloudRun } from '../../computer/queue-run'
import { ensureDeviceRepository } from '../../device-repositories'
import { notifyDeviceWork } from '../../device-gateway-notify'
import { tiptapToText } from '../../tiptap-text'
import { factoryEventId } from '../../factory/event-id'
import { queueFactoryTask } from '../../factory/task-dispatch'
import { factoryAutomaticRuntime } from '../../factory/automatic-dispatch'
import type { ReviewActor, ReviewScope } from './authority'
import type { ReviewBatchRow } from './batch-store'
import type { DiffDependencies } from './service'
import type { RunOrigin, RunOriginRef } from '../../run-origin'

const unavailable = () => new WorkspaceReviewError('workspace_review_unavailable')
const outdated = () => new WorkspaceReviewError('workspace_snapshot_outdated')

/** Ordinary ended threads reuse the same host Factory admission/queue. The
 * caller already holds task-thread, Task/Run and batch locks, and owns COMMIT.
 * There is no separate post-queue receipt window to recover or redispatch. */
export async function queueReviewContinuation(deps: DiffDependencies, tx: PoolClient, actor: ReviewActor,
  scope: ReviewScope, batch: ReviewBatchRow): Promise<{ runId: string; wake: () => Promise<void> }> {
  const runId = scope.identity.runId, agent = batch.input.agent
  if (!scope.taskId || !agent || agent.factory) throw unavailable()
  if ((await readRunChain(tx, actor.userId, runId))?.latestRunId !== runId
    || (await latestTaskRun(tx, actor.userId, scope.taskId))?.id !== runId) throw outdated()
  const { rows: [source] } = await tx.query<{
    agentId: string; deviceId: string; deviceRepoId: string; botId: string | null; agentDefinition: WorkerDefinitionSnapshot | null;
    deviceKind: string; remoteUrl: string | null; repositoryKey: string; runtimeBotId: string | null; workspaceId: string | null;
    questionContinuation: { requireSessionResume?: boolean } | null; origin: RunOrigin | null; originRef: RunOriginRef | null;
  }>(`SELECT r."agentId",r."deviceId",r."deviceRepoId",r."botId",r."agentDefinition",r."questionContinuation",r.origin,r."originRef",
      d.kind AS "deviceKind",repo."remoteUrl",repo."repoPath" AS "repositoryKey",b."botId" AS "runtimeBotId",b."workspaceId"
    FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    LEFT JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$3
      AND r.status IN ('succeeded','completed','failed','stopped','cancelled') FOR SHARE OF repo,d`, [runId, actor.userId, scope.taskId])
  if (!source || source.deviceRepoId !== scope.identity.repoId || source.repositoryKey !== scope.identity.repositoryKey
    || !source.remoteUrl || source.questionContinuation?.requireSessionResume || source.agentDefinition?.readOnly) throw unavailable()
  if ((await tx.query(`SELECT 1 FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2
    AND status NOT IN ('cancelled','revoked','passed')`, [actor.userId, scope.taskId])).rowCount) throw outdated()
  const model = threadRunModel(source.agentDefinition)
  if (!model) throw unavailable()
  const sourceEventId = factoryEventId('workspace-review-source', batch.id), key = `workspace-review:${batch.id}`
  await tx.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt")
    VALUES ($1,$2,$3,$4,'user_message',$5,$6,'background',clock_timestamp())`,
  [sourceEventId, actor.userId, source.botId, scope.taskId, key, {
    text: agent.text, source: 'thread_continuation', previousRunId: runId, workspaceReviewBatchId: batch.id, postedToChat: true,
  }])
  const attachment = { client: tx, prepareAttempt: async (client: PoolClient, task: { id: string; attemptId: string }) => {
    await client.query('UPDATE factory_attempts SET output=output || $2::jsonb WHERE id=$1 AND "taskId"=$3',
      [task.attemptId, { workspaceReview: { batchId: batch.id, fingerprint: batch.fingerprint } }, task.id])
  } }
  const common = { issueId: scope.taskId, botId: source.botId, key, sourceEventId, previousRunId: runId,
    selection: { sourceRunId: runId, model, batchId: batch.id, fingerprint: batch.fingerprint } }
  // A review continuation keeps the reviewed run's entry; a legacy source
  // names the host stage that dispatches it rather than guessing 'web'.
  const origin: RunOrigin = source.origin ?? 'factory', originRef = source.originRef ?? null
  if (source.deviceKind !== 'cloud') {
    const result = await queueFactoryTask(deps.database, actor.userId, { ...common, agentId: source.agentId, deviceRepoId: source.deviceRepoId,
      queue: (client, userId, input, botId, context) => queueFactoryRun(client, userId, input, botId, context, undefined,
        { ...model, origin, originRef, threadRunId: runId, pinnedDeviceId: source.agentDefinition?.pinnedDeviceId }) }, attachment)
    return { runId: result.runId, wake: async () => { notifyDeviceWork(source.deviceId) } }
  }
  if (!source.runtimeBotId || source.workspaceId !== actor.workspaceId || !source.agentDefinition) throw unavailable()
  const runtime = await ensureRecordedBotHarnessRuntime(tx, actor, source.runtimeBotId, source.agentDefinition.harness, { freshTask: true })
  if (!runtime) throw unavailable()
  const repo = await ensureDeviceRepository(actor.userId, runtime.deviceId, source.remoteUrl, tx)
  if (repo.repoPath !== scope.identity.repositoryKey) throw outdated()
  const { rows: [issue] } = await tx.query('SELECT title,content FROM issues WHERE id=$1', [scope.taskId])
  if (!issue) throw unavailable()
  const result = await queueFactoryTask(deps.database, actor.userId, { ...common, agentId: runtime.agentId, deviceRepoId: repo.id,
    queue: (client, _userId, _input, _botId, context) => queueCloudRun(deps.database, actor, {
      botId: source.runtimeBotId!, issueId: scope.taskId!, agentId: runtime.agentId, deviceRepoId: repo.id,
      title: issue.title, body: tiptapToText(issue.content), ...model, origin, originRef, withoutBot: source.botId === null,
      threadRunId: runId, sourceEventId: context.sourceEventId, idempotencyKey: `factory:${context.attemptId}`,
    }, client, context) }, attachment)
  return { runId: result.runId, wake: async () => {
    try { await factoryAutomaticRuntime.enqueue(deps.database, actor, runId, result.runId) }
    catch { await (await import('../../factory/cloud-stage-handoff')).failFactoryCloudStage(deps.database, actor, result.runId,
      'Cloud stage handoff could not be queued') }
  } }
}
