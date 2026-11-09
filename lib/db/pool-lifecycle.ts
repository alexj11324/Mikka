import { attachDatabasePool } from '@vercel/functions'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool } from 'pg'

const initialized = new WeakSet<Pool>()

/** Register raw pools, before authority proxies. Fluid keeps idle teardown
 * alive before suspension; it must never end a checked-out transaction. */
export function manageDatabasePool(pool: Pool): Pool {
  if (initialized.has(pool)) return pool
  initialized.add(pool)
  // pg-pool dispatches a queued query inside the previous client's release
  // callback. Keep the caller's request/operation and OTel context when that
  // callback finally acquires a connection; connect spans are intentionally off.
  const connect = pool.connect.bind(pool)
  pool.connect = ((callback?: Parameters<Pool['connect']>[0]) =>
    callback ? connect(AsyncLocalStorage.bind(callback)) : connect()) as Pool['connect']
  // pg removes a failed idle client itself. Consume its error without logging
  // server messages, SQL, parameters or connection credentials.
  pool.on('error', () => console.warn('database_pool_idle_connection_lost'))
  // Fluid releases idle clients when the isolate suspends. Off Vercel the helper
  // is not the runtime, and calling it there fails local and CI pools.
  if (process.env.VERCEL) attachDatabasePool(pool)
  return pool
}
