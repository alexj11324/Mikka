import { Pool, type PoolConfig } from 'pg'

export class AccountDeletionBusy extends Error {
  constructor() { super('accountDeletionBusy') }
}

/** Session advisory locks cannot use Neon's transaction pooler. Reuse the
 * configured database/credentials, changing only the documented Neon host. */
export function deletionLockPoolOptions(options: PoolConfig): PoolConfig {
  const directHost = (host: string) => host.endsWith('.neon.tech')
    ? host.replace(/-pooler(?=\.)/, '') : host
  const result = { ...options, max: 1, connectionTimeoutMillis: 5_000, application_name: 'mikka-account-deletion' }
  if (result.connectionString) {
    const url = new URL(result.connectionString)
    url.hostname = directHost(url.hostname)
    result.connectionString = url.href
  }
  if (result.host) result.host = directHost(result.host)
  return result
}

/** Each job owns a physical connection until close, including during provider
 * I/O. Destroying it releases every session lock, even when work throws. Never
 * return a locked backend to a reusable pool. Contention leaves the job alone. */
export async function acquireAccountDeletionLock(database: Pool, id: string) {
  const sessions = new Pool(deletionLockPoolOptions(database.options))
  try {
    const client = await sessions.connect()
    try {
      const locked = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`mikka-account-deletion-job:${id}`])
      if (!locked.rows[0]?.locked) throw new AccountDeletionBusy()
      return { client, close: async () => { client.release(true); await sessions.end() } }
    } catch (error) { client.release(true); throw error }
  } catch (error) { await sessions.end(); throw error }
}
