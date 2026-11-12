import 'server-only'
import type { Pool } from 'pg'
import { runChanged } from './live/panels'
import { runListChanged } from './live/lists'
import { runControlChanged } from './device-gateway-notify'
import { DEVICE_WORK_CHANNEL, notifyChannel } from './db/listen'
import { reviewSessionsRevoked } from './coding-workspace/review-sessions'

/** Account-scoped tokens can act as several devices. Stop only runs whose
 * authenticated claim recorded this token, without guessing legacy ownership. */
export async function revokeDeviceCredential(database: Pick<Pool, 'connect'>, ownerId: string, tokenId: string) {
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'")
    const token = (await client.query('SELECT id,"revokedAt","revokedBy" FROM device_tokens WHERE id=$1 AND "userId"=$2 FOR UPDATE', [tokenId, ownerId])).rows[0]
    if (!token) { await client.query('ROLLBACK'); return null }
    if (!token.revokedAt) {
      const revoked = (await client.query('UPDATE device_tokens SET "revokedAt"=clock_timestamp(),"revokedBy"=$2 WHERE id=$1 RETURNING "revokedAt","revokedBy"', [tokenId, ownerId])).rows[0]
      Object.assign(token, revoked)
      const stopped = await client.query<{ id: string }>(`UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",clock_timestamp()),
        "leaseExpiresAt"=LEAST("leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
        WHERE "deviceTokenId"=$1 AND "userId"=$2 AND status IN ('queued','preparing','running','waiting_input','finishing') RETURNING id`, [tokenId, ownerId])
      for (const { id } of stopped.rows) { await runListChanged(client, id); await runChanged(client, id) }
      // The revoked daemon may still hold its gateway socket: wake it to stop now.
      runControlChanged(client, { runIds: stopped.rows.map(row => row.id) })
      await client.query(`UPDATE run_tokens SET "revokedAt"=COALESCE("revokedAt",clock_timestamp())
        WHERE "runId" IN (SELECT id FROM agent_runs WHERE "deviceTokenId"=$1 AND "userId"=$2)`, [tokenId, ownerId])
      await client.query(`INSERT INTO device_credential_revocations ("tokenId","ownerId","actorId","revokedAt") VALUES($1,$2,$2,$3) ON CONFLICT ("tokenId") DO NOTHING`, [tokenId, ownerId, token.revokedAt])
      // A commands long poll on this credential re-checks on COMMIT and fails at once.
      await notifyChannel(client, DEVICE_WORK_CHANNEL, [`token:${tokenId}`])
    }
    reviewSessionsRevoked(client, { deviceTokenId: tokenId }, 'credential_revoked')
    const legacy = (await client.query(`SELECT count(*)::int AS count FROM agent_runs WHERE "userId"=$1
      AND "deviceTokenId" IS NULL AND status IN ('preparing','running','waiting_input','finishing')`, [ownerId])).rows[0].count as number
    await client.query('COMMIT')
    return { tokenId, revokedAt: new Date(token.revokedAt).toISOString(), revokedBy: token.revokedBy as string | null, unattributedActiveRuns: legacy }
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
