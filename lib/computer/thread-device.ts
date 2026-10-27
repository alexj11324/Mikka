import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

type Actor = { userId: string; workspaceId: string }

export async function claimThreadWorkerLease(pool: Pool, actor: Actor, runId: string, sandboxId: string, leaseId: string) {
  const result = await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$5,"workerLeaseUntil"=now()+interval '15 minutes'
    WHERE "runId"=$1 AND "workspaceId"=$2 AND "ownerId"=$3 AND "sandboxId"=$4 AND state='running'
      AND ("workerLeaseId" IS NULL OR "workerLeaseUntil" IS NULL OR "workerLeaseUntil"<=now()) RETURNING "runId"`,
  [runId, actor.workspaceId, actor.userId, sandboxId, leaseId])
  return result.rowCount === 1
}

export async function renewThreadWorkerLease(pool: Pool, actor: Actor, runId: string, leaseId: string) {
  const result = await pool.query(`UPDATE thread_machines SET "workerLeaseUntil"=now()+interval '15 minutes'
    WHERE "runId"=$1 AND "workspaceId"=$2 AND "ownerId"=$3 AND "workerLeaseId"=$4 AND "workerLeaseUntil">now() AND state='running' RETURNING "runId"`,
  [runId, actor.workspaceId, actor.userId, leaseId])
  return result.rowCount === 1
}

export async function releaseThreadWorkerLease(pool: Pool, actor: Actor, runId: string, leaseId: string) {
  await pool.query(`UPDATE thread_machines SET "workerLeaseId"=NULL,"workerLeaseUntil"=NULL
    WHERE "runId"=$1 AND "workspaceId"=$2 AND "ownerId"=$3 AND "workerLeaseId"=$4`, [runId, actor.workspaceId, actor.userId, leaseId])
}

/** Issue a device credential bound to this one thread machine. Never reuse a
 * Bot machine credential or snapshot a worker credential into a new machine. */
export async function provisionThreadDevice(pool: Pool, actor: Actor, runId: string, expiresAt: Date, leaseId: string) {
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new Error('Invalid cloud credential expiry')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const machine = (await client.query(`SELECT t."deviceId" FROM thread_machines t JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId"
      WHERE t."runId"=$1 AND t."workspaceId"=$2 AND t."ownerId"=$3 AND t.state='running'
        AND t."workerLeaseId"=$4 AND t."workerLeaseUntil">now()+interval '2 minutes'
        AND r.status IN ('queued','preparing','running','waiting_input','finishing') FOR UPDATE OF t,r`,
    [runId, actor.workspaceId, actor.userId, leaseId])).rows[0]
    if (!machine) throw new Error('Thread machine unavailable')
    let deviceId = machine.deviceId as string | null
    if (deviceId) {
      const device = await client.query('SELECT 1 FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind=$3', [deviceId, actor.userId, 'cloud'])
      if (!device.rowCount) throw new Error('Invalid thread device')
    } else {
      deviceId = randomUUID()
      await client.query('INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,$3,$4)', [deviceId, actor.userId, 'Cloud thread', 'cloud'])
      await client.query('UPDATE thread_machines SET "deviceId"=$2 WHERE "runId"=$1', [runId, deviceId])
    }
    await client.query('UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=$1 AND "revokedAt" IS NULL', [deviceId])
    const token = `orv_${randomBytes(32).toString('base64url')}`
    await client.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), actor.userId, 'Cloud thread worker', createHash('sha256').update(token).digest('hex'), deviceId, actor.workspaceId, expiresAt])
    await client.query('COMMIT')
    return { deviceId, token, expiresAt }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
