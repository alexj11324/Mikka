import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { queueFactoryRun } from '@/lib/agent-runs'
import { queueCloudRun } from '@/lib/computer/queue-run'
import { chooseCloudRunModel, threadRunModel } from '@/lib/computer/run-model'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { withDatabaseClient } from '@/lib/db'
import { tiptapToText } from '@/lib/tiptap-text'
import { createFactoryDispatch, factoryBinding } from './dispatch'
import { checkFactoryRepairBudget } from './check-recovery-evidence'
import { FactoryError } from './contract'
import type { FactoryTask, createFactoryStore } from './store'

/** Provider I/O boundary; no model input selects these callbacks. */
export const factoryAutomaticRuntime = {
  park: async (pool: Pool, actor: { userId: string; workspaceId: string }, runId: string) => (await import('@/lib/cloud-computer/thread-machines')).parkThreadMachine(pool, actor, runId),
  start: async (actor: { userId: string; workspaceId: string }, runId: string) => (await import('@/lib/run-leases')).startThreadMachine(actor, runId),
}

/** The host, rather than a model tool call, queues every independent stage. */
export function automaticFactoryDispatch(pool: Pool) {
  return async (tx: PoolClient, store: ReturnType<typeof createFactoryStore>, prior: FactoryTask, _run: Record<string, any>) => {
    let task = await store.lockTask(tx, prior.userId, prior.id)
    if (task.status === 'failed' && ['review','verify'].includes(task.stage)) {
      const { rows: [attempt] } = await tx.query('SELECT output FROM factory_attempts WHERE id=$1', [task.attemptId])
      if (attempt?.output?.completion?.trustedFailureProvenance === true) {
        try { await checkFactoryRepairBudget(tx, task) }
        catch (error) {
          if (!(error instanceof FactoryError) || error.code !== 'factoryRecoveryBudgetExceeded') throw error
          await tx.query(`UPDATE factory_attempts SET output=output || '{"reasonCode":"repair_budget_exhausted"}'::jsonb WHERE id=$1`, [task.attemptId])
          return
        }
        task = (await store.apply(task.userId, factoryBinding(task), (await import('./event-id')).factoryEventId('check-repair', task.attemptId), { action: 'repair', reason: task.reason.slice(0,4000) }, tx)).task
      }
    }
    if (task.status !== 'pending' || !['execute','review','verify'].includes(task.stage)) return
    const { rows: [source] } = await tx.query(`SELECT r.*,repo."remoteUrl",d.kind AS "deviceKind",b."botId" AS "runtimeBotId",b."workspaceId",a.harness
      FROM factory_attempts f JOIN agent_runs r ON r.id=f."runId"
      JOIN agents a ON a.id=r."agentId" JOIN devices d ON d.id=r."deviceId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId"
      LEFT JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      WHERE f."taskId"=$1 AND f.stage='execute' ORDER BY f.position DESC LIMIT 1`, [task.id])
    if (!source) throw new FactoryError('factoryRunMismatch')
    const check = task.stage !== 'execute'
    const selection = check ? {} : threadRunModel(source.agentDefinition) ?? {}
    if (source.deviceKind !== 'cloud') {
      const dispatch = createFactoryDispatch(pool, store, (client, userId, input, botId, context) => queueFactoryRun(client, userId, input, botId, context, undefined, { ...selection, readOnly: check || source.agentDefinition?.readOnly }))
      const result = await dispatch(task.userId, { binding: factoryBinding(task), agentId: source.agentId, deviceRepoId: source.deviceRepoId }, tx)
      if (!check) await tx.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [result.runId, source.id])
      return
    }
    const { rows: [runtime] } = await tx.query(`SELECT r."agentId",a."deviceId",r."repoId" FROM bot_cloud_runtimes r JOIN agents a ON a.id=r."agentId" WHERE r."botId"=$1 AND r."ownerId"=$2 AND r.harness=$3`, [source.runtimeBotId, task.userId, source.harness])
    if (!runtime) throw new FactoryError('factoryRunMismatch')
    const model = check ? await chooseCloudRunModel(pool, { ownerId: task.userId, workspaceId: source.workspaceId, botId: task.botId }, runtime.agentId, source.harness, undefined, source.remoteUrl ? 'task' : 'desktop') : selection
    if ('error' in model || !('model' in model) || typeof model.model !== 'string') throw new FactoryError('factoryCheckHarnessUnavailable')
    const cloudModel = model.model
    const repoId = source.remoteUrl ? (await withDatabaseClient(tx, () => ensureDeviceRepository(task.userId, runtime.deviceId, source.remoteUrl))).id : runtime.repoId
    const { rows: [issue] } = await tx.query('SELECT title,content FROM issues WHERE id=$1', [task.issueId])
    const actor = { userId: task.userId, workspaceId: source.workspaceId as string }
    const dispatch = createFactoryDispatch(pool, store, (client, _owner, _input, _bot, context) => queueCloudRun(pool, actor, {
      botId: source.runtimeBotId, issueId: task.issueId, agentId: runtime.agentId, deviceRepoId: repoId, title: issue.title, body: tiptapToText(issue.content), ...model, model: cloudModel,
      withoutBot: task.botId === null, readOnly: check || source.agentDefinition?.readOnly, idempotencyKey: `factory:${context.attemptId}`,
    }, client))
    const result = await dispatch(task.userId, { binding: factoryBinding(task), agentId: runtime.agentId, deviceRepoId: repoId }, tx)
    if (!check) await tx.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [result.runId, source.id])
    return async () => {
      // Retain the completed stage's actual filesystem/desktop before the
      // next independent CLI session adopts the task machine. No session is resumed.
      try {
        if (typeof _run.id === 'string') await factoryAutomaticRuntime.park(pool, actor, _run.id)
      } catch {
        const { rows: [ended] } = await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='device_lost',error='Previous stage artifacts could not be retained',"finishedAt"=now(),"updatedAt"=now()
          WHERE id=$1 AND "userId"=$2 AND status='queued' RETURNING *`, [result.runId, actor.userId])
        if (ended) {
          const [{ db }, { recordCoordinatorEvent }, { runFinishedEvent }, { wakeCoordinator }] = await Promise.all([import('@/lib/db'), import('@/lib/coordinator-event-store'), import('@/lib/coordinator-events'), import('@/lib/coordinator/wake')])
          await recordCoordinatorEvent(db, runFinishedEvent(ended))
          await wakeCoordinator(actor.userId).catch(() => undefined)
        }
        return
      }
      await factoryAutomaticRuntime.start(actor, result.runId)
    }
  }
}
