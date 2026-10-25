import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool, type Pool as DatabasePool } from 'pg'
import { mikkaDatabaseURL } from '@/lib/db/config'
import type { DeviceCaller } from '@/lib/device-link'

export const deviceRequestCaller = new AsyncLocalStorage<DeviceCaller>()

// Admission locks must not consume the application pool used by handlers:
// five admitted requests must still be able to execute their queries.
const admissionPool = new Pool({ connectionString: mikkaDatabaseURL(process.env), max: 5,
  connectionTimeoutMillis: 10_000, idleTimeoutMillis: 20_000 })
admissionPool.on('error', () => { /* individual guarded requests reject below */ })

/** Serialize credential revocation against admitted HTTP operations. Body
 * receipt precedes admission, so a stalled client cannot hold a token lock.
 * Long polling calls this once per read, never around its waiting loop. */
export async function withDeviceAdmission<T>(caller: DeviceCaller, fn: () => Promise<T>): Promise<T | null> {
  const client = await admissionPool.connect()
  let failed = false
  const onError = () => { failed = true }
  client.on('error', onError)
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'")
    const active = await client.query('SELECT id FROM device_tokens WHERE id=$1 AND "userId"=$2 AND "revokedAt" IS NULL FOR SHARE', [caller.tokenId, caller.userId])
    if (!active.rowCount) { await client.query('ROLLBACK'); return null }
    const result = await deviceRequestCaller.run(caller, fn)
    if (failed) throw new Error('Device admission connection lost')
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.off('error', onError); client.release(failed) }
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
      const revoked = (await client.query('UPDATE device_tokens SET "revokedAt"=clock_timestamp(),"revokedBy"=$2 WHERE id=$1 RETURNING "revokedAt","revokedBy"', [tokenId, ownerId])).rows[0]
      Object.assign(token, revoked)
      await client.query(`UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",clock_timestamp()),
        "leaseExpiresAt"=LEAST("leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
        WHERE "deviceTokenId"=$1 AND "userId"=$2 AND status IN ('queued','preparing','running','waiting_input','finishing')`, [tokenId, ownerId])
      await client.query(`UPDATE run_tokens SET "revokedAt"=COALESCE("revokedAt",clock_timestamp())
        WHERE "runId" IN (SELECT id FROM agent_runs WHERE "deviceTokenId"=$1 AND "userId"=$2)`, [tokenId, ownerId])
    }
    const legacy = (await client.query(`SELECT count(*)::int AS count FROM agent_runs WHERE "userId"=$1
      AND "deviceTokenId" IS NULL AND status IN ('preparing','running','waiting_input','finishing')`, [ownerId])).rows[0].count as number
    await client.query('COMMIT')
    return { tokenId, revokedAt: new Date(token.revokedAt).toISOString(), revokedBy: token.revokedBy as string, unattributedActiveRuns: legacy }
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
