import 'server-only'
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'

export type DeviceCommandKind = 'redetect' | 'restart' | 'update' | 'uninstall'
export const DEVICE_UNINSTALL_GRACE_MS = 10 * 60_000
export async function enqueueDeviceCommand(userId: string, deviceId: string, kind: DeviceCommandKind, database: Pick<Pool, 'query'> = pool) {
  const result = await database.query(`INSERT INTO device_management_commands (id,"deviceId",kind)
    SELECT $1,id,$4 FROM devices WHERE id=$2 AND "ownerId"=$3 AND kind='local' AND "removedAt" IS NULL RETURNING id`, [randomUUID(), deviceId, userId, kind])
  return result.rows[0]?.id as string | undefined
}
export async function pendingDeviceCommands(deviceId: string, completed: string[], failed: { id: string; error: string }[] = []) {
  const connection = await pool.connect()
  try {
    await connection.query('BEGIN')
    const device = (await connection.query(`SELECT "removedAt" FROM devices WHERE id=$1 FOR UPDATE`, [deviceId])).rows[0]
    if (!device) { await connection.query('COMMIT'); return [] }
    const removed = Boolean(device.removedAt)
    const acknowledged = completed.length ? await connection.query(`UPDATE device_management_commands SET "completedAt"=now() WHERE "deviceId"=$1 AND id=ANY($2::uuid[]) AND "completedAt" IS NULL AND (NOT $3::boolean OR kind='uninstall') RETURNING kind`, [deviceId, completed, removed]) : null
    if (removed && acknowledged?.rows.some(row => row.kind === 'uninstall')) {
      await connection.query(`UPDATE device_tokens SET "revokedAt"=now() WHERE "userId"=(SELECT "ownerId" FROM devices WHERE id=$1) AND "revokedAt" IS NULL AND (id IN (SELECT "tokenId" FROM device_token_devices WHERE "deviceId"=$1) OR "boundDeviceId"=$1)`, [deviceId])
    }
    if (!removed) for (const failure of failed) await connection.query(`UPDATE device_management_commands SET "completedAt"=now(),error=$3 WHERE "deviceId"=$1 AND id=$2 AND "completedAt" IS NULL`, [deviceId, failure.id, failure.error])
    const result = await connection.query<{ id: string; kind: DeviceCommandKind }>(`SELECT id,kind FROM device_management_commands WHERE "deviceId"=$1 AND "completedAt" IS NULL AND (NOT $2::boolean OR kind='uninstall') ORDER BY "createdAt" LIMIT 1`, [deviceId, removed])
    await connection.query('COMMIT')
    return result.rows
  } catch (error) { await connection.query('ROLLBACK'); throw error }
  finally { connection.release() }
}
