import { randomUUID } from 'node:crypto'
import { copyRunPrompt } from '../../run-prompt-copy'
import type { PoolClient } from 'pg'
import type { agentRuns } from '../../db/schema'
import { retryWorkerDefinition } from '../../agent-kit/worker'
import { acceptLocalRun } from '../../run-admission-store'
import { FactoryError } from '../contract'
import type { FactoryQueue } from '../dispatch'
import { resolveRunOrigin } from '../../run-origin'

/** Resume the answered local question's frozen worker. Ordinary admission still
 * checks today's task, policy, device, repository and credential authority. */
export async function queueLocalQuestionContinuation(
  tx: PoolClient, userId: string, input: Parameters<FactoryQueue>[2],
  botId: string | null, context: Parameters<FactoryQueue>[4],
): Promise<{ runId: string } | null> {
  if (!context.questionOriginRunId) return null
  const { rows: [origin] } = await tx.query<typeof agentRuns.$inferSelect>(`SELECT r.*
    FROM agent_runs r
    JOIN factory_questions q ON q."originRunId"=r.id AND q."userId"=r."userId" AND q."originSessionId"=r."sessionId"
    JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=q."userId" AND t."issueId"=r."issueId"
      AND t."botId" IS NOT DISTINCT FROM r."botId"
    JOIN coordinator_events e ON e.id=t."sourceEventId" AND e."userId"=t."userId"
      AND e."botId" IS NOT DISTINCT FROM t."botId" AND e.kind='user_message'
      AND (e."issueId" IS NULL OR e."issueId"=t."issueId")
    WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$3 AND r."agentId"=$4 AND r."deviceRepoId"=$5
      AND r."botId" IS NOT DISTINCT FROM $6::uuid AND t."attemptId"=$7 AND t."sourceEventId"=$8
      AND q.status='answered' AND t.status='pending' AND r.status='stopped'
      AND r."stopRequestedAt" IS NULL AND NULLIF(r."sessionId",'') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id)
    FOR UPDATE OF r FOR SHARE OF e`, [context.questionOriginRunId,userId,input.issueId,input.agentId,input.deviceRepoId,botId,context.attemptId,context.sourceEventId])
  if (!origin?.agentDefinition?.executionIdentity || !origin.deviceId || !origin.deviceRepoId || !origin.issueId)
    throw new FactoryError('factoryQuestionContinuationUnavailable')
  const copied = copyRunPrompt(origin, `${origin.prompt}\n\n${input.note ?? ''}`)
  const { prompt } = copied
  const definition = retryWorkerDefinition(origin.agentDefinition, prompt)!
  // Revalidate the frozen executionIdentity (including its original workspace,
  // exact subscription/key and current revocation state), never mint a new one
  // from today's Agent preferences. acceptLocalRun also keeps publication scope.
  const result = await acceptLocalRun({
    id: randomUUID(), userId, botId: origin.botId, issueId: origin.issueId,
    agentId: origin.agentId, deviceId: origin.deviceId, deviceRepoId: origin.deviceRepoId,
    source: origin.source, ...resolveRunOrigin({ sourceRun: origin, defaultOrigin: origin.source === 'mcp' ? 'api' : 'automation' }),
    ...copied, definition, continuation: true, sourceRunId: origin.id,
    requestEventId: definition.repositoryAdmission?.requestEventId,
  }, tx)
  const { recordFactoryDispatchFailure } = await import('../dispatch-recovery')
  await recordFactoryDispatchFailure(tx, userId, result.runId, context.attemptId)
  return { runId: result.runId }
}
