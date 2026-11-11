import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool, type PoolClient } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { mikkaDatabaseURL } from './config'
import { deviceScopedPool, readUnderAuthority } from './device-scope'
import { sampleClient } from './egress-sample'
import { samplePoolTransport } from './transport-sample'
import { manageDatabasePool } from './pool-lifecycle'
import { COMMIT_EXECUTOR, observePoolCommits } from './commit-effects'

const defaultConnectionString = mikkaDatabaseURL(process.env)

function createPool(connectionString = defaultConnectionString, scope: 'default' | 'request' = 'default') {
  const pool = manageDatabasePool(new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 }))
  observePoolCommits(pool)
  pool.on('connect', client => sampleClient(client))
  samplePoolTransport(pool, scope)
  return pool
}

function createDatabase(client: Pool) {
  return drizzle(client, { schema })
}

const globalDb = globalThis as unknown as { mikkaPool?: Pool }
const defaultPool = process.env.VERCEL_ENV === 'preview' ? createPool() : globalDb.mikkaPool ?? createPool()
observePoolCommits(defaultPool)
if (process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'preview') globalDb.mikkaPool = defaultPool
const defaultDatabase = createDatabase(defaultPool)
const requestDatabase = new AsyncLocalStorage<{ pool: Pool; db: typeof defaultDatabase }>()
type Transaction = Parameters<Parameters<typeof defaultDatabase.transaction>[0]>[0]
const heldClient = new AsyncLocalStorage<PoolClient>()
const transactionDatabase = new AsyncLocalStorage<Transaction | NodePgDatabase<typeof schema>>()

/** The actual request-routed pool identity, before per-statement authority wrappers. */
export function currentDatabasePool(): Pool {
  return requestDatabase.getStore()?.pool ?? defaultPool
}

export const pool = new Proxy(defaultPool, {
  get(target, property) {
    if (property === COMMIT_EXECUTOR) return heldClient.getStore() ?? requestDatabase.getStore()?.pool ?? target
    if (property === 'query' && heldClient.getStore()) return heldClient.getStore()!.query.bind(heldClient.getStore()!)
    const current = deviceScopedPool(requestDatabase.getStore()?.pool ?? target)
    const value = Reflect.get(current, property, current)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

const scopedDatabases = new WeakMap<Pool, typeof defaultDatabase>()

export const db = new Proxy(defaultDatabase, {
  get(target, property) {
    const base = requestDatabase.getStore()?.pool ?? defaultPool
    const guarded = deviceScopedPool(base)
    let current = transactionDatabase.getStore() ?? requestDatabase.getStore()?.db ?? target
    // Ambient transactions already use the checked-out guarded connection.
    if (!transactionDatabase.getStore() && guarded !== base) {
      let scoped = scopedDatabases.get(guarded)
      if (!scoped) { scoped = createDatabase(guarded); scopedDatabases.set(guarded, scoped) }
      current = scoped
    }
    const value = Reflect.get(current, property, current)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

/** Keep composed actions on the caller's transaction; nested actions use savepoints. */
export function withDatabaseTransaction<T>(transaction: Transaction, callback: () => T): T {
  return transactionDatabase.run(transaction, callback)
}

/** Reuse an already-open SQL transaction without acquiring another pool connection. */
export function withDatabaseClient<T>(client: PoolClient, callback: () => T): T {
  return heldClient.run(client, () => transactionDatabase.run(drizzle(client, { schema }), callback))
}

/** A held client or an ambient transaction: this read may see its own uncommitted writes. */
export function inDatabaseTransaction() {
  return Boolean(heldClient.getStore() || transactionDatabase.getStore())
}

/** After-commit work must not retain a client that its owner has returned to the pool. */
export function withoutDatabaseClient<T>(callback: () => T): T {
  return heldClient.exit(() => transactionDatabase.exit(callback))
}

/** A single read whose statement checks the daemon's credential itself (device-scope.ts `readUnderAuthority`). */
export function readUnderDeviceAuthority<T>(select: string, params: readonly unknown[]): Promise<T> {
  return readUnderAuthority<T>(requestDatabase.getStore()?.pool ?? defaultPool, select, params)
}

export function createRequestDatabaseScope(connectionString: string) {
  const requestPool = createPool(connectionString, 'request')
  const requestDb = createDatabase(requestPool)
  let closePromise: Promise<void> | undefined

  return {
    run<T>(callback: () => T) {
      return requestDatabase.run({ pool: requestPool, db: requestDb }, callback)
    },
    close() {
      return closePromise ??= requestPool.end()
    },
  }
}
