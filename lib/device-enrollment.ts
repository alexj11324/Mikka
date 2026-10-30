import 'server-only'
import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { hashDeviceToken, newDeviceToken } from '@/lib/device-link'

export async function mintDeviceEnrollment(userId: string) {
  const token = newDeviceToken()
  await pool.query(`INSERT INTO device_enrollments ("tokenHash","userId","expiresAt") VALUES ($1,$2,now()+interval '5 minutes')`, [hashDeviceToken(token), userId])
  return token
}

/** Consumption and credential issuance commit together; parallel replay loses. */
export async function consumeDeviceEnrollment(token: string): Promise<string | null> {
  const connection = await pool.connect()
  try {
    await connection.query('BEGIN')
    const grant = await connection.query<{ userId: string }>(`DELETE FROM device_enrollments WHERE "tokenHash"=$1 AND "expiresAt">now() RETURNING "userId"`, [hashDeviceToken(token)])
    if (!grant.rows[0]) { await connection.query('ROLLBACK'); return null }
    const credential = newDeviceToken()
    await connection.query(`INSERT INTO device_tokens (id,"userId","tokenHash",name) VALUES ($1,$2,$3,'SSH')`, [randomUUID(), grant.rows[0].userId, hashDeviceToken(credential)])
    await connection.query('COMMIT')
    return credential
  } catch (error) { await connection.query('ROLLBACK'); throw error }
  finally { connection.release() }
}
