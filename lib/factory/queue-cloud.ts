import 'server-only'
import { queueCloudRun } from '@/lib/computer/queue-run'
import { queueFactoryTask } from './task-dispatch'

/** The caller starts the thread machine and its lifecycle after this transaction commits. */
export async function queueFactoryCloudRun(pool: Parameters<typeof queueCloudRun>[0], actor: Parameters<typeof queueCloudRun>[1], input: Parameters<typeof queueCloudRun>[2] & { sourceEventId?: string; factoryBotId?: string | null }) {
  const previous = input.threadRunId ? (await pool.query(`SELECT t."botId",t.status FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE a."runId"=$1 AND t."userId"=$2 ORDER BY a.position DESC LIMIT 1`, [input.threadRunId, actor.userId])).rows[0] : undefined
  return queueFactoryTask(pool, actor.userId, {
    issueId: input.issueId, botId: previous && !['passed','cancelled','revoked'].includes(previous.status) ? previous.botId : input.factoryBotId !== undefined ? input.factoryBotId : input.withoutBot ? null : input.botId, agentId: input.agentId, deviceRepoId: input.deviceRepoId,
    note: input.note, key: input.idempotencyKey, previousRunId: input.threadRunId, sourceEventId: input.sourceEventId,
    selection: [input.model, input.apiKeyId, input.subscriptionBindingId, input.apiKey, Boolean(input.readOnly), input.execution?.id],
    queue: (tx, _owner, _request, _bot, context) => queueCloudRun(pool, actor, { ...input, idempotencyKey: `factory:${context.attemptId}` }, tx),
  })
}
