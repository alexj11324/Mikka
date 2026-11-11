import 'server-only'
import { queueCloudRun } from '@/lib/computer/queue-run'
import { queueFactoryTask } from './task-dispatch'
import { continuedRunPolicyCeiling } from '@/lib/computer/run-model'
import { refreshProfileQuota } from './profile-admission'
import { resolveRunOrigin } from '@/lib/run-origin'

/** The caller starts the thread machine and its lifecycle after this transaction commits. */
export async function queueFactoryCloudRun(pool: Parameters<typeof queueCloudRun>[0], actor: Parameters<typeof queueCloudRun>[1], input: Parameters<typeof queueCloudRun>[2] & { sourceEventId?: string; factoryBotId?: string | null; needsSpec?: boolean }) {
  input = { ...input, policyCeiling: await continuedRunPolicyCeiling(pool, actor.userId, input.issueId, input.threadRunId, input.policyCeiling) }
  const previous = input.threadRunId ? (await pool.query(`SELECT t."botId",t.status FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE a."runId"=$1 AND t."userId"=$2 ORDER BY a.position DESC LIMIT 1`, [input.threadRunId, actor.userId])).rows[0] : undefined
  await refreshProfileQuota(pool, { ownerId: actor.userId, workspaceId: actor.workspaceId, agentId: input.agentId,
    model: input.model, subscriptionBindingId: input.subscriptionBindingId, selection: input.agentProfile })
  return queueFactoryTask(pool, actor.userId, {
    issueId: input.issueId, botId: previous && !['cancelled','revoked'].includes(previous.status) ? previous.botId : input.factoryBotId !== undefined ? input.factoryBotId : input.withoutBot ? null : input.botId, agentId: input.agentId, deviceRepoId: input.deviceRepoId,
    note: input.note, key: input.idempotencyKey, previousRunId: input.threadRunId, sourceEventId: input.sourceEventId, needsSpec: input.needsSpec,
    selection: [input.model, input.apiKeyId, input.subscriptionBindingId, input.apiKey, Boolean(input.readOnly), input.execution?.id, ...(input.allowLocalRecovery === true ? [{ allowLocalRecovery: true }] : []), ...(input.modelDispatch ? [{ modelDispatch: input.modelDispatch }] : []), ...(input.agentProfile ? [{ agentProfile: input.agentProfile }] : []), ...(input.policyCeiling ? [{ policyCeiling: input.policyCeiling }] : [])],
    queue: (tx, _owner, _request, _bot, context) => queueCloudRun(pool, actor, { ...input,
      // The Factory's own cloud queue is the entry when the caller named none.
      ...resolveRunOrigin({ explicit: input.origin ? { origin: input.origin, originRef: input.originRef } : null, defaultOrigin: 'factory' }),
      readOnly: context.stage === 'spec' || input.readOnly, sourceEventId: context.sourceEventId, idempotencyKey: `factory:${context.attemptId}` }, tx),
  })
}
