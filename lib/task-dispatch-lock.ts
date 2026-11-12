import 'server-only'
import { Pool } from 'pg'
import { currentDatabasePool } from '@/lib/db/request-scope'
import { manageDatabasePool } from '@/lib/db/pool-lifecycle'
import { samplePoolTransport } from '@/lib/db/transport-sample'

const lockPools = new WeakMap<Pool, Pool>()

function taskLockPool(): Pool {
  const application = currentDatabasePool()
  let locks = lockPools.get(application)
  if (locks) return locks
  // A dispatch holds its lock while admission performs business queries. The
  // lock must not consume the last connection those queries need to finish.
  locks = manageDatabasePool(new Pool({ ...application.options, max: 2, allowExitOnIdle: true }))
  samplePoolTransport(locks, 'default')
  lockPools.set(application, locks)
  const closeApplication = application.end.bind(application)
  const lockPool = locks
  let closing: Promise<void> | undefined
  application.end = ((callback?: (error?: Error) => void) => {
    // Request database scopes close their derived lock pool too. Let an
    // active lock owner finish using APP before closing its business pool.
    const closed = closing ??= lockPool.end().then(() => closeApplication())
    if (callback) { void closed.then(() => callback(), callback); return }
    return closed
  }) as Pool['end']
  return locks
}

/** Cross-process task serialization, compatible with transaction-pooling PgBouncer. */
export async function withTaskDispatchLock<T>(userId: string, issueId: string, work: () => Promise<T>): Promise<T> {
  const client = await taskLockPool().connect()
  let discard = false
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['task-thread', userId, issueId])])
    const result = await work()
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { discard = true }
    throw error
  } finally { client.release(discard) }
}
