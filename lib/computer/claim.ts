import 'server-only'
import type { Pool } from 'pg'

/** The existing local daemon cannot operate a Bot's cloud desktop. Keep its
 * claim serialized with Bot binding and fail closed until a cloud worker with
 * the computer tool and approval gate can claim the run. */
export async function claimLocalRun(pool: Pool, runId: string, deviceId: string, leaseExpiresAt: Date, subscriptionBindingId?: string): Promise<'claimed' | 'unavailable' | 'cloud-required'> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const run = (await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "deviceId"=$2 AND status=$3 FOR UPDATE', [runId, deviceId, 'queued'])).rows[0]
    if (!run) { await client.query('COMMIT'); return 'unavailable' }
    const bound = (await client.query('SELECT 1 FROM computer_run_bindings WHERE "runId"=$1', [runId])).rowCount
    if (bound) { await client.query('COMMIT'); return 'cloud-required' }
    if (subscriptionBindingId) await client.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)', [runId, subscriptionBindingId])
    await client.query('UPDATE agent_runs SET status=$2,"startedAt"=now(),"leaseExpiresAt"=$3,"updatedAt"=now() WHERE id=$1', [runId, 'preparing', leaseExpiresAt])
    await client.query('COMMIT')
    return 'claimed'
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
