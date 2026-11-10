import 'server-only'
import { pool } from '@/lib/db'
import { queueFactoryRun, type queueRun, type RunDispatchOrigin } from '@/lib/agent-runs'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { ActionFailureError } from '@/lib/action-error'
import { queueFactoryTask } from './task-dispatch'
import { continuedRunPolicyCeiling } from '@/lib/computer/run-model'

export async function queueTaskRun(userId: string, input: Parameters<typeof queueRun>[1] & { needsSpec?: boolean }, botId: string | null = null,
  execution?: Parameters<typeof queueRun>[3], sourceEventId?: string, dispatch: RunDispatchOrigin = {}) {
  // Entry provenance never enters the selection digest: a retry from another
  // entry is the same work, not a conflict. Production callers pass `origin`;
  // lib/run-origin-writes.test.ts enumerates them so a new caller cannot rely
  // on this default.
  const source = dispatch.source ?? null
  const origin = dispatch.origin ?? 'web'
  input = { ...input, policyCeiling: await continuedRunPolicyCeiling(pool, userId, input.issueId, input.threadRunId, input.policyCeiling) }
  const { rows: [agent] } = await pool.query('SELECT "deviceId" FROM agents WHERE id=$1 AND "userId"=$2', [input.agentId, userId])
  if (!agent?.deviceId) throw new ActionFailureError('agentNoDevice')
  const repo = await ensureDeviceRepository(userId, agent.deviceId, input.repo)
  const previous = input.threadRunId ? (await pool.query(`SELECT t."botId",t.status FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE a."runId"=$1 AND t."userId"=$2 ORDER BY a.position DESC LIMIT 1`, [input.threadRunId, userId])).rows[0] : undefined
  if (previous && !['cancelled','revoked'].includes(previous.status)) botId = previous.botId
  return queueFactoryTask(pool, userId, {
    issueId: input.issueId, botId, agentId: input.agentId, deviceRepoId: repo.id, note: input.note,
    key: input.requestKey, sourceEventId, previousRunId: input.threadRunId, needsSpec: input.needsSpec,
    selection: [input.model, input.apiKeyId, input.subscriptionBindingId, input.pinnedDeviceId, Boolean(input.readOnly), execution?.id, source, ...(input.modelDispatch ? [{ modelDispatch: input.modelDispatch }] : []), ...(input.agentProfile ? [{ agentProfile: input.agentProfile }] : []), ...(input.policyCeiling ? [{ policyCeiling: input.policyCeiling }] : [])],
    queue: async (tx, owner, request, scopeBot, context) => {
      const result = await queueFactoryRun(tx, owner, request, scopeBot, context, undefined, { threadRunId: input.threadRunId, model: input.model, apiKeyId: input.apiKeyId,
        subscriptionBindingId: input.subscriptionBindingId, modelDispatch: input.modelDispatch, agentProfile: input.agentProfile, policyCeiling: input.policyCeiling, pinnedDeviceId: input.pinnedDeviceId, readOnly: context.stage === 'spec' || input.readOnly, execution, origin, originRef: dispatch.originRef ?? null })
      if (source) await tx.query('UPDATE agent_runs SET source=$2 WHERE id=$1', [result.runId, source])
      return result
    },
  })
}
