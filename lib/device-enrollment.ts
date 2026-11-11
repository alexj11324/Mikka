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
  const credential = newDeviceToken()
  const { rows } = await pool.query<{ id: string }>(`WITH consumed AS (
    DELETE FROM device_enrollments WHERE "tokenHash"=$1 AND "expiresAt">now() RETURNING "userId"
  ) INSERT INTO device_tokens (id,"userId","tokenHash",name)
    SELECT $2,"userId",$3,'SSH' FROM consumed RETURNING id`, [hashDeviceToken(token), randomUUID(), hashDeviceToken(credential)])
  return rows.length ? credential : null
}
