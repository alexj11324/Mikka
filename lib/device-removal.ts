import 'server-only'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { pool } from '@/lib/db'
import { DEVICE_ONLINE_WINDOW_MS } from '@/lib/device-link'
import { DEVICE_UNINSTALL_GRACE_MS, enqueueDeviceCommand } from '@/lib/device-management'

/** Same limit as a device token's name (createDeviceToken). */
export const DEVICE_NAME_MAX = 60

/** Run states where the daemon may still be working on the device. */
const LIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing'] as const

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
 * agents lose their binding and the row becomes a disabled tombstone. An online
 * daemon receives uninstall, with credentials restricted until receipt or expiry;
 * offline credentials are revoked immediately. History references remain intact.
 */
export async function removeOwnedDevice(userId: string, id: unknown): Promise<{ id: string; revokedTokens: number; uninstall: 'queued' | 'not_possible' }> {
  const target = deviceId(id)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Lock in run admission's order (agents, then devices) so the two never deadlock.
    await client.query(`SELECT id FROM agents WHERE "deviceId"=$1 AND "userId"=$2 FOR UPDATE`, [target, userId])
    // Run admission reads this row FOR SHARE and requires enabled, so no run
    // can be admitted between the check below and the commit.
    const device = await client.query(`SELECT id,"lastSeenAt" FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND "removedAt" IS NULL FOR UPDATE`, [target, userId])
    if (!device.rowCount) throw new ActionFailureError('deviceNotFound')
    const live = await client.query(`SELECT 1 FROM agent_runs WHERE "deviceId"=$1 AND status = ANY($2::text[]) LIMIT 1`, [target, [...LIVE_RUN_STATUSES]])
    if (live.rowCount) throw new ActionFailureError('deviceHasActiveRuns')
    const row = device.rows[0]
    const online = row.lastSeenAt && Date.now() - new Date(row.lastSeenAt).getTime() < DEVICE_ONLINE_WINDOW_MS
    if (online) await enqueueDeviceCommand(userId, target, 'uninstall', client)
    const revoked = await client.query(`WITH changed AS (
      UPDATE device_tokens SET "revokedAt"=CASE WHEN $3::boolean THEN NULL ELSE now() END,
        "revokedBy"=CASE WHEN $3::boolean THEN "revokedBy" ELSE $2 END,
        "expiresAt"=CASE WHEN $3::boolean THEN LEAST("expiresAt",$4::timestamptz) ELSE "expiresAt" END
      WHERE "userId"=$2 AND "revokedAt" IS NULL
        AND (id IN (SELECT "tokenId" FROM device_token_devices WHERE "deviceId"=$1) OR "boundDeviceId"=$1)
      RETURNING id,"revokedAt"
    ), receipts AS (
      INSERT INTO device_credential_revocations ("tokenId","ownerId","actorId","revokedAt")
      SELECT id,$2,$2,"revokedAt" FROM changed WHERE "revokedAt" IS NOT NULL
      RETURNING "tokenId"
    ) SELECT id FROM changed`, [target, userId, Boolean(online), new Date(Date.now() + DEVICE_UNINSTALL_GRACE_MS)])
    await client.query(`UPDATE agents SET "deviceId"=NULL,"updatedAt"=now() WHERE "deviceId"=$1 AND "userId"=$2`, [target, userId])
    await client.query(`UPDATE devices SET "removedAt"=now(),enabled=false,"updatedAt"=now() WHERE id=$1`, [target])
    await client.query('COMMIT')
    return { id: target, revokedTokens: online ? 0 : revoked.rowCount ?? 0, uninstall: online ? 'queued' : 'not_possible' }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
