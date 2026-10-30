import 'server-only'
import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'

export type DeviceCommandKind = 'redetect' | 'restart' | 'update'
export async function enqueueDeviceCommand(userId: string, deviceId: string, kind: DeviceCommandKind) {
  const result = await pool.query(`INSERT INTO device_management_commands (id,"deviceId",kind)
    SELECT $1,id,$4 FROM devices WHERE id=$2 AND "ownerId"=$3 AND kind='local' RETURNING id`, [randomUUID(), deviceId, userId, kind])
  return result.rows[0]?.id as string | undefined
}
export async function pendingDeviceCommands(deviceId: string, completed: string[], failed: { id: string; error: string }[] = []) {
  const connection = await pool.connect()
  try {
    await connection.query('BEGIN')
    if (completed.length) await connection.query(`UPDATE device_management_commands SET "completedAt"=now() WHERE "deviceId"=$1 AND id=ANY($2::uuid[])`, [deviceId, completed])
    for (const failure of failed) await connection.query(`UPDATE device_management_commands SET "completedAt"=now(),error=$3 WHERE "deviceId"=$1 AND id=$2`, [deviceId, failure.id, failure.error])
    const result = await connection.query<{ id: string; kind: DeviceCommandKind }>(`SELECT id,kind FROM device_management_commands WHERE "deviceId"=$1 AND "completedAt" IS NULL ORDER BY "createdAt" LIMIT 1`, [deviceId])
    await connection.query('COMMIT')
    return result.rows
  } catch (error) { await connection.query('ROLLBACK'); throw error }
  finally { connection.release() }
}
