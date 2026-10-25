import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool as DatabasePool } from 'pg'
import { pool } from '@/lib/db'
import { withDeviceDatabaseAuthority, isDeviceAuthorityRevoked } from '@/lib/db/device-scope'
import { appendAudit, auditActor } from '@/lib/audit/store'
import type { DeviceCaller } from '@/lib/device-link'

export const deviceRequestCaller = new AsyncLocalStorage<DeviceCaller>()

/** Each application SQL statement/transaction checks and locks authority on
 * its own write connection. No independent lock can survive or fail separately. */
export async function withDeviceAdmission<T>(caller: DeviceCaller, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await withDeviceDatabaseAuthority(caller, async () => {
      await pool.query('SELECT 1')
      return deviceRequestCaller.run(caller, fn)
    })
  } catch (error) {
    if (isDeviceAuthorityRevoked(error)) return null
    throw error
  }
}

/** The token is account-scoped; revoking it must not revoke another token of
 * the same owner. Existing attributed attempts are stopped in this commit. */
export async function revokeDeviceCredential(database: DatabasePool, ownerId: string, tokenId: string) {
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'")
    const token = (await client.query('SELECT id,"revokedAt","revokedBy" FROM device_tokens WHERE id=$1 AND "userId"=$2 FOR UPDATE', [tokenId, ownerId])).rows[0]
    if (!token) { await client.query('ROLLBACK'); return null }
    if (!token.revokedAt) {
      await auditActor(client, ownerId, 'human', tokenId)
      const revoked = (await client.query('UPDATE device_tokens SET "revokedAt"=clock_timestamp(),"revokedBy"=$2 WHERE id=$1 RETURNING "revokedAt","revokedBy"', [tokenId, ownerId])).rows[0]
      Object.assign(token, revoked)
      await client.query(`UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",clock_timestamp()),
        "leaseExpiresAt"=LEAST("leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
        WHERE "deviceTokenId"=$1 AND "userId"=$2 AND status IN ('queued','preparing','running','waiting_input','finishing')`, [tokenId, ownerId])
      await client.query(`UPDATE run_tokens SET "revokedAt"=COALESCE("revokedAt",clock_timestamp())
        WHERE "runId" IN (SELECT id FROM agent_runs WHERE "deviceTokenId"=$1 AND "userId"=$2)`, [tokenId, ownerId])
      await appendAudit(client, `personal:${ownerId}`, { actorId: ownerId, actorType: 'human', resourceId: tokenId, action: 'device.credential.revoked', outcome: 'success', reason: 'owner_requested', operationId: tokenId }, tokenId)
    }
    const legacy = (await client.query(`SELECT count(*)::int AS count FROM agent_runs WHERE "userId"=$1
      AND "deviceTokenId" IS NULL AND status IN ('preparing','running','waiting_input','finishing')`, [ownerId])).rows[0].count as number
    await client.query('COMMIT')
    return { tokenId, revokedAt: new Date(token.revokedAt).toISOString(), revokedBy: token.revokedBy as string, unattributedActiveRuns: legacy }
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
