import { Pool, type PoolConfig } from 'pg'
import { directPoolOptions } from '../../scripts/postgres-connection.mjs'

export class AccountDeletionBusy extends Error {
  constructor() { super('accountDeletionBusy') }
}
export class AccountDeletionLockLost extends Error {
  constructor() { super('accountDeletionLockLost') }
}

/** Session advisory locks use the configured direct connection for this database. */
export function deletionLockPoolOptions(options: PoolConfig): PoolConfig {
  const result = { ...directPoolOptions(options), max: 1, connectionTimeoutMillis: 5_000, application_name: 'mikka-account-deletion' }
  return result
}

/** Each job owns a physical connection until close, including during provider
 * I/O. Destroying it releases every session lock, even when work throws. Never
 * return a locked backend to a reusable pool. Contention leaves the job alone. */
export async function acquireAccountDeletionLock(database: Pool, id: string) {
  const sessions = new Pool(deletionLockPoolOptions(database.options))
  const client = await sessions.connect().catch(async error => { await sessions.end(); throw error })
  let lost = false, closed: Promise<void> | undefined
  const invalidate = () => { lost = true }
  // Checked-out pg clients have no pool idle error listener. Keep ours through
  // provider I/O and physical shutdown, and refuse the next stage after loss.
  client.on('error', invalidate); client.on('end', invalidate)
  sessions.on('error', invalidate)
  const assertHeld = () => { if (lost) throw new AccountDeletionLockLost() }
  const rethrow = async (error: unknown): Promise<never> => {
    // A FATAL response may reject an active query before the socket end event
    // arrives. Verify this same session before classifying a stage error.
    if (!lost) try { await client.query('SELECT 1') } catch { invalidate() }
    assertHeld()
    throw error
  }
  const close = () => closed ??= (async () => {
    try { await client.end() }
    finally {
      client.release(true); await sessions.end()
      client.off('error', invalidate); client.off('end', invalidate)
    }
  })()
  try {
    const locked = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`mikka-account-deletion-job:${id}`])
    assertHeld()
    if (!locked.rows[0]?.locked) throw new AccountDeletionBusy()
    return { client, assertHeld, rethrow, close }
  } catch (error) { await close(); throw error }
}
