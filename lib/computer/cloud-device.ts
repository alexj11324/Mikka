import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** Rotate a credential for the trusted worker of an existing workspace
 * machine. The plaintext is returned only to the caller for delivery to the
 * worker; the database stores its hash. */
export async function provisionCloudDevice(pool: Pool, actor: { userId: string; workspaceId: string }, expiresAt: Date, leaseId?: string) {
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new Error('Invalid cloud credential expiry')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const machine = (await client.query(`SELECT "deviceId" FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2
      AND ($3::uuid IS NULL OR ("workerLeaseId"=$3 AND "workerLeaseUntil">now()+interval '2 minutes')) FOR UPDATE`, [actor.workspaceId, actor.userId, leaseId ?? null])).rows[0]
    if (!machine) throw new Error('Cloud machine not found')
    let deviceId: string = machine.deviceId
    if (deviceId) {
      const device = await client.query('SELECT 1 FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind=$3', [deviceId, actor.userId, 'cloud'])
      if (!device.rowCount) throw new Error('Invalid cloud device')
    } else {
      deviceId = randomUUID()
      await client.query('INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,$3,$4)', [deviceId, actor.userId, 'Cloud computer', 'cloud'])
      await client.query('UPDATE cloud_machines SET "deviceId"=$2 WHERE "workspaceId"=$1', [actor.workspaceId, deviceId])
    }
    await client.query('UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=$1 AND "revokedAt" IS NULL', [deviceId])
    const token = `orv_${randomBytes(32).toString('base64url')}`
    const tokenHash = createHash('sha256').update(token).digest('hex')
    await client.query('INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), actor.userId, 'Cloud computer worker', tokenHash, deviceId, actor.workspaceId, expiresAt])
    await client.query('COMMIT')
    return { deviceId, token, expiresAt }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
