import 'server-only'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { pool } from '@/lib/db'

/** Same limit as a device token's name (createDeviceToken). */
export const DEVICE_NAME_MAX = 60

/** Run states where the daemon may still be working on the device. */
const LIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const

export function parseDeviceName(name: unknown): string {
  if (typeof name !== 'string') throw new ActionFailureError('validationNameRequired')
  const trimmed = name.trim()
  if (!trimmed) throw new ActionFailureError('validationNameRequired')
  if (trimmed.length > DEVICE_NAME_MAX) throw new ActionFailureError('deviceNameTooLong')
  return trimmed
}

function deviceId(id: unknown): string {
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) throw new ActionFailureError('deviceNotFound')
  return parsed.data
}

/**
 * Renames one of the person's local devices. The name is locked, so the
 * daemon's next register keeps it instead of its hostname.
 */
export async function renameOwnedDevice(userId: string, id: unknown, name: unknown): Promise<{ id: string; name: string }> {
  const target = deviceId(id)
  const value = parseDeviceName(name)
  const { rows } = await pool.query(`UPDATE devices SET name=$3,"nameLocked"=true,"updatedAt"=now()
    WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND "removedAt" IS NULL RETURNING id,name`, [target, userId, value])
  if (!rows[0]) throw new ActionFailureError('deviceNotFound')
  return { id: rows[0].id, name: rows[0].name }
}

/**
 * Removes one of the person's local devices from settings.
 *
 * Refused while a thread is live on it. Otherwise, in one transaction: every
 * credential that acted as the device is revoked (the daemon gets 401 on its
 * next call), its agents lose the device binding (no new runs), and the row
 * becomes a disabled tombstone. Run history keeps its device, repository and
 * agent references; nothing is cascaded away.
 */
export async function removeOwnedDevice(userId: string, id: unknown): Promise<{ id: string; revokedTokens: number }> {
  const target = deviceId(id)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Lock in run admission's order (agents, then devices) so the two never deadlock.
    await client.query(`SELECT id FROM agents WHERE "deviceId"=$1 AND "userId"=$2 FOR UPDATE`, [target, userId])
    // Run admission reads this row FOR SHARE and requires enabled, so no run
    // can be admitted between the check below and the commit.
    const device = await client.query(`SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND "removedAt" IS NULL FOR UPDATE`, [target, userId])
    if (!device.rowCount) throw new ActionFailureError('deviceNotFound')
    const live = await client.query(`SELECT 1 FROM agent_runs WHERE "deviceId"=$1 AND status = ANY($2::text[]) LIMIT 1`, [target, [...LIVE_RUN_STATUSES]])
    if (live.rowCount) throw new ActionFailureError('deviceHasActiveRuns')
    const revoked = await client.query(`WITH revoked AS (UPDATE device_tokens SET "revokedAt"=now(),"revokedBy"=$2
      WHERE "userId"=$2 AND "revokedAt" IS NULL
        AND (id IN (SELECT "tokenId" FROM device_token_devices WHERE "deviceId"=$1) OR "boundDeviceId"=$1)
      RETURNING id,"revokedAt")
      INSERT INTO device_credential_revocations ("tokenId","ownerId","actorId","revokedAt")
      SELECT id,$2,$2,"revokedAt" FROM revoked RETURNING "tokenId" AS id`, [target, userId])
    await client.query(`UPDATE agents SET "deviceId"=NULL,"updatedAt"=now() WHERE "deviceId"=$1 AND "userId"=$2`, [target, userId])
    await client.query(`UPDATE devices SET "removedAt"=now(),enabled=false,"updatedAt"=now() WHERE id=$1`, [target])
    await client.query('COMMIT')
    return { id: target, revokedTokens: revoked.rowCount ?? 0 }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
