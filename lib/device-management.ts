import 'server-only'
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'

export type DeviceCommandKind = 'redetect' | 'restart' | 'update'
export async function enqueueDeviceCommand(userId: string, deviceId: string, kind: DeviceCommandKind, database: Pick<Pool, 'query'> = pool) {
  const result = await database.query(`INSERT INTO device_management_commands (id,"deviceId",kind)
    SELECT $1,id,$4 FROM devices WHERE id=$2 AND "ownerId"=$3 AND kind='local' AND "removedAt" IS NULL RETURNING id`, [randomUUID(), deviceId, userId, kind])
  return result.rows[0]?.id as string | undefined
}
export async function pendingDeviceCommands(deviceId: string, completed: string[], failed: { id: string; error: string }[] = []) {
  const connection = await pool.connect()
  try {
    await connection.query('BEGIN')
    if (completed.length) await connection.query(`UPDATE device_management_commands SET "completedAt"=now() WHERE "deviceId"=$1 AND id=ANY($2::uuid[]) AND "completedAt" IS NULL`, [deviceId, completed])
    for (const failure of failed) await connection.query(`UPDATE device_management_commands SET "completedAt"=now(),error=$3 WHERE "deviceId"=$1 AND id=$2 AND "completedAt" IS NULL`, [deviceId, failure.id, failure.error])
    const result = await connection.query<{ id: string; kind: DeviceCommandKind }>(`SELECT id,kind FROM device_management_commands WHERE "deviceId"=$1 AND "completedAt" IS NULL ORDER BY "createdAt" LIMIT 1`, [deviceId])
    await connection.query('COMMIT')
    return result.rows
  } catch (error) { await connection.query('ROLLBACK'); throw error }
  finally { connection.release() }
}
