import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { WorkerDefinitionSnapshot } from '@/lib/agent-kit/worker'
import { ActionFailureError } from '@/lib/action-error'
import { ComputerError } from '@/lib/computer/store'
import { queueCloudRun } from '@/lib/computer/queue-run'
import { collaborativeCloudTaskTarget } from '@/lib/computer/cloud-task-target'
import { mintNextCollaborationReceipt } from '@/lib/collaboration-run-authority'
import { tiptapToText } from '@/lib/tiptap-text'
import { FactoryError } from './contract'
import { createFactoryDispatch, defaultFactoryDispatchAdapters, factoryBinding } from './dispatch'
import { factoryEventId } from './event-id'
import { factoryAuthorizationCheckpoint } from './transaction'
import type { FactoryTask, createFactoryStore } from './store'

/** Automatic stages retain the actual human actor and exact paid resources.
 * The established Factory dispatch/configuration still owns the stage. Only
 * its host authority and dedicated target differ from an owner's new task. */
export async function dispatchCollaborativeFactoryStage(pool: Pool, tx: PoolClient, store: ReturnType<typeof createFactoryStore>,
  task: FactoryTask, input: { previousRunId: string; producerDefinition: WorkerDefinitionSnapshot | null },
): Promise<{ runId?: string } | null> {
  const { rows: [previous] } = await tx.query<{
    id: string; agentDefinition: WorkerDefinitionSnapshot; runtimeBotId: string; deviceKind: string;
  }>(`SELECT r.id,r."agentDefinition",binding."botId" AS "runtimeBotId",device.kind AS "deviceKind"
    FROM agent_runs r JOIN factory_attempts attempt ON attempt."runId"=r.id AND attempt."taskId"=$2
    JOIN devices device ON device.id=r."deviceId" AND device."ownerId"=r."userId"
    LEFT JOIN computer_run_bindings binding ON binding."runId"=r.id AND binding."ownerId"=r."userId" AND binding."workspaceId"=r."workspaceId"
    WHERE r.id=$1 AND r."userId"=$3 AND r."workspaceId"=$4 AND r."issueId"=$5`,
  [input.previousRunId, task.id, task.userId, task.workspaceId, task.issueId])
  const identity = previous?.agentDefinition?.executionIdentity
  const producerActor = input.producerDefinition?.executionIdentity?.actor
  if ((!identity?.actor || identity.actor === task.userId) && (!producerActor || producerActor === task.userId)) return null
  const restore = factoryAuthorizationCheckpoint(tx)
  await tx.query('SAVEPOINT factory_collaboration_dispatch')
  try {
    const definition = previous?.agentDefinition
    if (!previous || !identity || identity.version !== 2 || identity.actor === task.userId || !identity.collaborationAuthorizationId
      || previous.deviceKind !== 'cloud' || !previous.runtimeBotId || !task.workspaceId
      || !definition?.apiKey || definition.subscription || definition.allowLocalRecovery
      || !definition.model || !['claude_code', 'codex'].includes(definition.harness))
      throw new ActionFailureError('executionAccountUnavailable')
    const next = await mintNextCollaborationReceipt(tx, { authorizationId: identity.collaborationAuthorizationId,
      sourceRunId: previous.id, requestId: factoryEventId('collaboration-stage', task.attemptId) })
    const authority = { actorId: next.actorId, threadOwnerId: next.threadOwnerId, collaborationAuthorizationId: next.authorizationId }
    const target = await collaborativeCloudTaskTarget(tx, task.userId, { sourceRunId: previous.id, botId: previous.runtimeBotId,
      issueId: task.issueId, harness: definition.harness, model: definition.model, keyId: definition.apiKey.keyId }, authority)
    if (!target || target.workspaceId !== task.workspaceId) throw new ActionFailureError('executionAccountUnavailable')
    const { rows: [issue] } = await tx.query('SELECT title,content FROM issues WHERE id=$1 AND "workspaceId"=$2 AND "ownershipState"=\'bound\'', [task.issueId, task.workspaceId])
    if (!issue) throw new FactoryError('factoryRunMismatch')
    const actor = { userId: task.userId, workspaceId: task.workspaceId }
    const dispatch = createFactoryDispatch(pool, store, (client, _owner, _input, _bot, context) => queueCloudRun(pool, actor, {
      botId: previous.runtimeBotId, issueId: task.issueId, agentId: target.agentId, deviceRepoId: target.repoId,
      title: issue.title, body: tiptapToText(issue.content), model: definition.model!, apiKeyId: definition.apiKey!.keyId,
      modelDispatch: definition.modelDispatch ? { ...definition.modelDispatch, mode: 'picked' } : undefined,
      policyCeiling: definition.policyCeiling, withoutBot: task.botId === null,
      threadRunId: previous.id, readOnly: task.stage !== 'execute' || definition.readOnly,
      sourceEventId: context.sourceEventId, idempotencyKey: `factory:${context.attemptId}`,
    }, client, context, authority), defaultFactoryDispatchAdapters)
    const result = await dispatch(task.userId, { binding: factoryBinding(task), agentId: target.agentId, deviceRepoId: target.repoId }, tx)
    // ACL ancestry is independent of native session continuation. Independent
    // checks retain their fresh session; execute turns keep the prior thread.
    if (task.stage === 'execute') await tx.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [result.runId, previous.id])
    await tx.query('RELEASE SAVEPOINT factory_collaboration_dispatch')
    return { runId: result.runId }
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT factory_collaboration_dispatch')
    restore()
    await tx.query('RELEASE SAVEPOINT factory_collaboration_dispatch')
    if (!(error instanceof ActionFailureError && ['executionAccountUnavailable', 'threadExecutionAuthorizationRequired', 'threadExecutionBudgetExceeded', 'workspaceAccessDenied'].includes(error.code))
      && !(error instanceof ComputerError && error.status === 409)) throw error
    const current = await store.lockTask(tx, task.userId, task.id)
    const code = error instanceof ActionFailureError ? error.code : error.message === 'personal_git_authorization_required'
      ? 'personal_git_authorization_required' : 'executionAccountUnavailable'
    await store.apply(task.userId, factoryBinding(current), factoryEventId('collaboration-stage-blocked', task.attemptId), {
      action: 'finish', status: 'blocked', reason: 'The shared execution authorization is unavailable or its resource budget has ended.',
      evidence: [], output: { dispatch: { code } },
    }, tx)
    return {}
  }
}
