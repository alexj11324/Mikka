import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import * as provider from './e2b-provider'
import { prepareWorkspaceSnapshot } from './workspace-snapshot'
import { ThreadMachines } from './thread-machine'
import { startThreadWorker } from './thread-worker'

type Actor = { userId: string; workspaceId: string }

/** Provision before pinning the queued run. A shared Bot worker cannot see or
 * claim it in the meantime. Repeated requests reuse the run and sandbox. */
export async function provisionCloudThread(pool: Pool, actor: Actor, runId: string, botId: string, runtime = provider) {
  const guard = await pool.connect()
  try {
    await guard.query('BEGIN')
    await guard.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread-provision:${runId}`])
    const result = await provisionLocked(pool, actor, runId, botId, runtime)
    await guard.query('COMMIT')
    return result
  } catch (error) { await guard.query('ROLLBACK'); throw error } finally { guard.release() }
}

async function provisionLocked(pool: Pool, actor: Actor, runId: string, botId: string, runtime: typeof provider) {
  const origin = process.env.MIKKA_CLOUD_WORKER_URL, sha = process.env.MIKKA_CLOUD_WORKER_SHA
  if (!origin || !sha) throw new Error('Cloud worker is not configured')
  const already = (await pool.query(`SELECT t."deviceId" FROM thread_machines t JOIN computer_run_bindings b ON b."runId"=t."runId"
    JOIN agent_runs r ON r.id=t."runId" AND r."deviceId"=t."deviceId"
    WHERE t."runId"=$1 AND t."workspaceId"=$2 AND t."ownerId"=$3 AND b."botId"=$4 AND t."deviceId" IS NOT NULL
      AND r.status IN ('queued','preparing','running','waiting_input','finishing') AND r."stopRequestedAt" IS NULL`,
  [runId, actor.workspaceId, actor.userId, botId])).rows[0]
  if (already) return { runId, deviceId: already.deviceId as string }
  await prepareWorkspaceSnapshot(pool, actor, runId, botId, sha, runtime)
  const machines = new ThreadMachines(pool, runtime.threadMachineProvider)
  const sandboxId = await machines.wake(actor, runId)
  const sandbox = await runtime.connectComputer(sandboxId)
  const worker = await startThreadWorker(pool, actor, runId, sandbox, origin, sha, runtime)
  // A workspace snapshot has its Git repository at this fixed path. Do not
  // let a caller or model pick an arbitrary path on the thread machine.
  await sandbox.commands.run('git -C /workspace rev-parse --verify HEAD >/dev/null', { user: 'mikka-runner', timeoutMs: 20_000 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    const target = (await client.query(`SELECT r.status,r."stopRequestedAt",r."deviceId",r."deviceRepoId",src."baseBranch",src."remoteUrl",src."verifyCommand"
      FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      JOIN thread_machines t ON t."runId"=r.id AND t."workspaceId"=b."workspaceId" AND t."ownerId"=b."ownerId" AND t."deviceId"=$4 AND t."sandboxId"=$5 AND t.state='running'
      JOIN bot_cloud_runtimes br ON br."botId"=b."botId" AND br."workspaceId"=b."workspaceId" AND br."ownerId"=b."ownerId" AND br."agentId"=r."agentId"
      JOIN device_repos src ON src.id=br."repoId" AND src."userId"=b."ownerId"
      WHERE r.id=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3 AND b."botId"=$6
        AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny') FOR UPDATE OF r`,
    [runId, actor.workspaceId, actor.userId, worker.deviceId, sandboxId, botId])).rows[0]
    if (!target || target.status !== 'queued' || target.stopRequestedAt) throw new Error('Thread is no longer queued')
    if (target.deviceId && target.deviceId !== worker.deviceId) throw new Error('Thread device changed')
    const repo = (await client.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch","remoteUrl","verifyCommand")
      VALUES ($1,$2,$3,'/workspace',$4,$5,$6) ON CONFLICT ("deviceId","repoPath") DO UPDATE SET "repoPath"=EXCLUDED."repoPath"
      WHERE device_repos."userId"=EXCLUDED."userId" RETURNING id`, [randomUUID(), worker.deviceId, actor.userId, target.baseBranch, target.remoteUrl, target.verifyCommand])).rows[0]
    if (!repo) throw new Error('Thread repository unavailable')
    await client.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"updatedAt"=now() WHERE id=$1', [runId, worker.deviceId, repo.id])
    await client.query('COMMIT')
    return { runId, deviceId: worker.deviceId }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
