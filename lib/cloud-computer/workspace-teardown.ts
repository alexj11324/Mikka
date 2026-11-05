import 'server-only'
import type { Pool } from 'pg'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { sandboxGone, threadMachineProvider } from './thread-machines'
import { armDueTimerAfterCommit } from '@/lib/due-timer'

/** Kills a sandbox on its owner's own E2B key (orchestration § 2). Tests replace threadMachineProvider.kill. */
export type KillSandbox = (ownerId: string, sandboxId: string) => Promise<void>
const ownerKill: KillSandbox = (ownerId, sandboxId) => threadMachineProvider.kill(sandboxId, ownerId)

interface Pending { sandboxId: string; ownerId: string }

/** One kill; the retry row goes once E2B confirms it or no longer has the sandbox. Never throws. */
async function attempt(database: Pick<Pool, 'query'>, kill: KillSandbox, row: Pending) {
  try { await kill(row.ownerId, row.sandboxId) }
  catch (error) {
    if (!sandboxGone(error)) {
      // No error text: it could carry provider detail. The count is enough to find it.
      await database.query('UPDATE sandbox_kill_retries SET attempts=attempts+1,"lastAttemptAt"=now() WHERE "sandboxId"=$1', [row.sandboxId])
      return false
    }
  }
  await database.query('DELETE FROM sandbox_kill_retries WHERE "sandboxId"=$1 AND "ownerId"=$2', [row.sandboxId, row.ownerId])
  return true
}

/**
 * 删除工作区, and account deletion for the workspaces only that person belongs
 * to: every Bot computer (cloud_machines) and thread machine of the workspace,
 * whoever owns it, is fenced and its sandbox killed before the rows go. In one
 * transaction the runs on those machines stop, their worker credentials are
 * revoked, their devices are removed and a retry row is written per sandbox;
 * then each sandbox is killed on its owner's key. A failed kill never stops the
 * deletion: its row stays and the run-recovery cron retries it
 * (retrySandboxKills). `exceptOwner` skips machines an earlier step already
 * cleaned up for that person (lib/account/runtime-cleanup.ts).
 */
export async function teardownWorkspaceMachines(database: Pool, workspaceId: string, options: { exceptOwner?: string; kill?: KillSandbox } = {}) {
  const except = options.exceptOwner ?? null
  const client = await database.connect()
  let pending: Pending[]
  try {
    await client.query('BEGIN')
    const threads = (await client.query<{ runId: string; ownerId: string; sandboxId: string | null; deviceId: string | null }>(
      'SELECT "runId","ownerId","sandboxId","deviceId" FROM thread_machines WHERE "workspaceId"=$1 AND ($2::text IS NULL OR "ownerId"<>$2) FOR UPDATE', [workspaceId, except])).rows
    const computers = (await client.query<{ ownerId: string; sandboxId: string | null; deviceId: string | null }>(
      'SELECT "ownerId","sandboxId","deviceId" FROM cloud_machines WHERE "workspaceId"=$1 AND ($2::text IS NULL OR "ownerId"<>$2) FOR UPDATE', [workspaceId, except])).rows
    const machines = [...threads, ...computers]
    const devices = [...new Set(machines.flatMap(row => row.deviceId ? [row.deviceId] : []))]
    await client.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"=COALESCE("stopRequestedAt",now()),"finishedAt"=COALESCE("finishedAt",now()),"updatedAt"=now()
      WHERE (id=ANY($1::uuid[]) OR "deviceId"=ANY($2::uuid[])) AND status=ANY($3::text[])`, [threads.map(row => row.runId), devices, [...UNFINISHED_RUN_STATUSES]])
    // device_tokens are keyed by boundWorkspaceId, not "workspaceId": deleting the workspace's rows would leave them valid.
    await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=ANY($1::uuid[])', [devices])
    await client.query('UPDATE devices SET "removedAt"=COALESCE("removedAt",now()) WHERE id=ANY($1::uuid[]) AND kind=\'cloud\'', [devices])
    pending = machines.flatMap(row => row.sandboxId ? [{ sandboxId: row.sandboxId, ownerId: row.ownerId }] : [])
    if (pending.length) await client.query(`INSERT INTO sandbox_kill_retries ("sandboxId","ownerId") SELECT * FROM unnest($1::text[],$2::text[]) ON CONFLICT ("sandboxId") DO NOTHING`,
      [pending.map(row => row.sandboxId), pending.map(row => row.ownerId)])
    if (pending.length) armDueTimerAfterCommit(client, 'run-recovery')
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  const killed = await Promise.all(pending.map(row => attempt(database, options.kill ?? ownerKill, row)))
  return { killed: killed.filter(Boolean).length, pending: killed.filter(done => !done).length }
}

/**
 * The run-recovery cron's retry of kills a deletion could not finish; with
 * `ownerId`, only that person's (account deletion retries them while their key
 * still exists). Returns how many are still pending.
 */
export async function retrySandboxKills(database: Pool, options: { ownerId?: string; kill?: KillSandbox; limit?: number } = {}) {
  const rows = (await database.query<Pending>(`SELECT "sandboxId","ownerId" FROM sandbox_kill_retries WHERE ($1::text IS NULL OR "ownerId"=$1)
    ORDER BY "lastAttemptAt" NULLS FIRST,"createdAt" LIMIT $2`, [options.ownerId ?? null, options.limit ?? 50])).rows
  let killed = 0
  for (const row of rows) if (await attempt(database, options.kill ?? ownerKill, row)) killed++
  return { killed, pending: rows.length - killed }
}
