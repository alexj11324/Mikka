import type { Pool, PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { FactoryError } from './contract'
import { factoryBinding, type createFactoryDispatch, type FactoryDispatchOptions } from './dispatch'
import type { createFactoryStore, FactoryTask } from './store'
import { chooseCloudRunModel, chooseLocalRunModel, threadRunModel } from '@/lib/computer/run-model'

/** Reuse the execute placement, with a new run/session for each independent
 * check. Called under the same task lock/transaction that advances its stage. */
export async function dispatchNextFactoryAttempt(tx: PoolClient, store: ReturnType<typeof createFactoryStore>, dispatch: (...args: Parameters<ReturnType<typeof createFactoryDispatch>>) => Promise<{runId:string}>, task: FactoryTask) {
  if (task.status !== 'pending' || !['execute', 'review', 'verify'].includes(task.stage)) return
  const run = (await tx.query(`SELECT r.*,b."workspaceId",b."botId" AS "runtimeBotId",a.harness FROM factory_attempts f
    JOIN agent_runs r ON r.id=f."runId" JOIN agents a ON a.id=r."agentId"
    LEFT JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    WHERE f."taskId"=$1 AND f.stage IN ('execute','spec') ORDER BY (f.stage='execute') DESC,f.position DESC LIMIT 1`, [task.id])).rows[0]
  if (!run) return
  let agentId = run.agentId, deviceRepoId = run.deviceRepoId
  const options: FactoryDispatchOptions = {}
  const workspaceId = run.workspaceId ?? (await tx.query('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [task.botId, task.userId])).rows[0]?.workspaceId
    ?? await (await import('@/lib/execution-settings')).executionWorkspace(task.userId, task.botId)
  const scope = { ownerId: task.userId, workspaceId, botId: task.botId }
  let selected
  if (run.runtimeBotId) {
    const runtime = (await tx.query(`SELECT c."agentId",a."deviceId",repo.id AS "repoId" FROM bot_cloud_runtimes c
      JOIN agents a ON a.id=c."agentId" AND a."userId"=c."ownerId"
      JOIN device_repos source ON source.id=$3 AND source."userId"=c."ownerId"
      JOIN device_repos repo ON repo."deviceId"=a."deviceId" AND repo."userId"=c."ownerId" AND repo."repoPath"=source."repoPath"
      WHERE c."botId"=$1 AND c."ownerId"=$2 AND c.harness=$4`, [run.runtimeBotId, task.userId, deviceRepoId, run.harness])).rows[0]
    if (!runtime) throw new FactoryError('factoryCheckHarnessUnavailable')
    agentId = runtime.agentId; deviceRepoId = runtime.repoId
    options.cloud = { botId: run.runtimeBotId, workspaceId }
    selected = task.stage === 'execute' ? threadRunModel(run.agentDefinition) : await chooseCloudRunModel(pool, scope, agentId, run.harness)
  } else {
    selected = task.stage === 'execute' ? threadRunModel(run.agentDefinition) : await chooseLocalRunModel(pool, scope, { id: agentId, deviceId: run.deviceId, harness: run.harness })
  }
  if (!selected || 'error' in selected) throw new FactoryError('factoryCheckHarnessUnavailable')
  options.selection = { ...selected, readOnly: task.stage !== 'execute' || run.agentDefinition?.readOnly === true, ...(options.cloud ? {} : { pinnedDeviceId: run.deviceId }) }
  const result = await dispatch(task.userId, { binding: factoryBinding(task), agentId, deviceRepoId }, tx, options)
  if (task.stage === 'execute') await tx.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [result.runId, run.id])
}

/** Provision only committed, currently bound runs. A sweep can retry startup
 * after a process crash without producing another attempt. */
export async function startFactoryCloudRuns(database: Pool, userId: string, taskId: string) {
  const { rows } = await database.query(`SELECT r.id,r."questionContinuation",b."workspaceId" FROM factory_tasks t
    JOIN factory_attempts a ON a.id=t."attemptId" JOIN agent_runs r ON r.id=a."runId"
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=t."userId"
    JOIN thread_machines m ON m."runId"=r.id WHERE t.id=$1 AND t."userId"=$2 AND t.status='running'
    AND r.status='queued' AND r."stopRequestedAt" IS NULL AND m.state='starting'`, [taskId,userId]);
  for (const row of rows) {
    const actor = { userId, workspaceId: row.workspaceId as string };
    const machines = await import('@/lib/cloud-computer/thread-machines');
    if (row.questionContinuation?.originRunId) await machines.parkThreadMachine(database,actor,row.questionContinuation.originRunId);
    await machines.ensureThreadMachine(database,actor,row.id);
    const { start } = await import('workflow/api');
    const { threadMachineLifecycle } = await import('@/workflows/thread-machine/workflow');
    await start(threadMachineLifecycle,[actor,row.id]);
  }
}
