import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

type Actor = { userId: string; workspaceId: string }
type Machine = { runId: string; snapshotId: string; operationId: string; sandboxId: string | null; state: 'starting' | 'running' | 'paused' | 'ended' | 'error' }
export type ThreadMachineProvider = {
  create(snapshotId: string, runId: string, operationId: string): Promise<{ sandboxId: string }>
  resume(sandboxId: string): Promise<void>
  pause(sandboxId: string): Promise<void>
  kill(sandboxId: string): Promise<void>
}
const terminal = new Set(['succeeded', 'stopped', 'failed', 'cancelled'])

/** Serializes lifecycle operations with run completion and other requests.
 * The stable operation id is persisted before provisioning so a lost provider
 * response can be retried with the same idempotency key. */
export class ThreadMachines {
  constructor(private readonly pool: Pool, private readonly provider: ThreadMachineProvider) {}

  private async lockRun(client: PoolClient, actor: Actor, runId: string) {
    const result = await client.query(`SELECT r.status FROM agent_runs r
      JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      WHERE r.id=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3 FOR UPDATE OF r`, [runId, actor.workspaceId, actor.userId])
    if (!result.rowCount) throw new Error('Thread unavailable')
    return result.rows[0].status as string
  }

  async wake(actor: Actor, runId: string): Promise<string> {
    // This row is committed separately so a retry can reuse the provider key.
    await this.pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","snapshotId","operationId")
      SELECT b."runId",b."workspaceId",b."ownerId",s."snapshotId",$4 FROM computer_run_bindings b
      JOIN workspace_snapshots s ON s."workspaceId"=b."workspaceId" AND s."ownerId"=b."ownerId"
      WHERE b."runId"=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3 ON CONFLICT ("runId") DO NOTHING`,
    [runId, actor.workspaceId, actor.userId, randomUUID()])
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const status = await this.lockRun(client, actor, runId)
      if (terminal.has(status)) throw new Error('Thread has ended')
      const result = await client.query<Machine>('SELECT * FROM thread_machines WHERE "runId"=$1 AND "workspaceId"=$2 AND "ownerId"=$3 FOR UPDATE', [runId, actor.workspaceId, actor.userId])
      const machine = result.rows[0]
      if (!machine || machine.state === 'ended') throw new Error('Thread machine unavailable')
      let sandboxId = machine.sandboxId
      if (!sandboxId) sandboxId = (await this.provider.create(machine.snapshotId, runId, machine.operationId)).sandboxId
      else await this.provider.resume(sandboxId)
      await client.query('UPDATE thread_machines SET "sandboxId"=$2,state=$3,"lastActiveAt"=now() WHERE "runId"=$1', [runId, sandboxId, 'running'])
      await client.query('COMMIT')
      return sandboxId
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async pause(actor: Actor, runId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const status = await this.lockRun(client, actor, runId)
      if (status !== 'waiting_input') throw new Error('Thread is not idle')
      const machine = (await client.query<Machine>('SELECT * FROM thread_machines WHERE "runId"=$1 AND "workspaceId"=$2 AND "ownerId"=$3 FOR UPDATE', [runId, actor.workspaceId, actor.userId])).rows[0]
      if (!machine || machine.state === 'ended' || !machine.sandboxId) throw new Error('Thread machine unavailable')
      if (machine.state !== 'paused') await this.provider.pause(machine.sandboxId)
      await client.query('UPDATE thread_machines SET state=$2,"lastActiveAt"=now() WHERE "runId"=$1', [runId, 'paused'])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async end(actor: Actor, runId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const status = await this.lockRun(client, actor, runId)
      if (!terminal.has(status)) throw new Error('Thread is still active')
      const machine = (await client.query<Machine>('SELECT * FROM thread_machines WHERE "runId"=$1 AND "workspaceId"=$2 AND "ownerId"=$3 FOR UPDATE', [runId, actor.workspaceId, actor.userId])).rows[0]
      if (machine && machine.state !== 'ended') {
        // A create response may have been lost before sandboxId was saved.
        // Resolve the same idempotency key before killing, so a cancelled run
        // cannot leave an untracked paused sandbox behind.
        const sandboxId = machine.sandboxId ?? (await this.provider.create(machine.snapshotId, runId, machine.operationId)).sandboxId
        await this.provider.kill(sandboxId)
        await client.query('UPDATE thread_machines SET state=$2,"lastActiveAt"=now() WHERE "runId"=$1', [runId, 'ended'])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
