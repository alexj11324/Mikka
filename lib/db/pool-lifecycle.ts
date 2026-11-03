import { attachDatabasePool } from '@vercel/functions'
import type { Pool } from 'pg'

const initialized = new WeakSet<Pool>()

/** Register raw pools, before authority proxies. Fluid keeps idle teardown
 * alive before suspension; it must never end a checked-out transaction. */
export function manageDatabasePool(pool: Pool): Pool {
  if (initialized.has(pool)) return pool
  initialized.add(pool)
  // pg removes a failed idle client itself. Consume its error without logging
  // server messages, SQL, parameters or connection credentials.
  pool.on('error', () => console.warn('database_pool_idle_connection_lost'))
  attachDatabasePool(pool)
  return pool
}
