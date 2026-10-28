import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool, type PoolClient } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { mikkaDatabaseURL } from './config'

const defaultConnectionString = mikkaDatabaseURL(process.env)

function createPool(connectionString = defaultConnectionString) {
  return new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
}

function createDatabase(client: Pool) {
  return drizzle(client, { schema })
}

const globalDb = globalThis as unknown as { mikkaPool?: Pool }
const defaultPool = process.env.VERCEL_ENV === 'preview' ? createPool() : globalDb.mikkaPool ?? createPool()
if (process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'preview') globalDb.mikkaPool = defaultPool
const defaultDatabase = createDatabase(defaultPool)
const requestDatabase = new AsyncLocalStorage<{ pool: Pool; db: typeof defaultDatabase }>()
type Transaction = Parameters<Parameters<typeof defaultDatabase.transaction>[0]>[0]
const heldClient = new AsyncLocalStorage<PoolClient>()
const transactionDatabase = new AsyncLocalStorage<Transaction | NodePgDatabase<typeof schema>>()

export const pool = new Proxy(defaultPool, {
  get(target, property) {
    if (property === 'query' && heldClient.getStore()) return heldClient.getStore()!.query.bind(heldClient.getStore()!)
    const current = requestDatabase.getStore()?.pool ?? target
    const value = Reflect.get(current, property, current)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

export const db = new Proxy(defaultDatabase, {
  get(target, property) {
    const current = transactionDatabase.getStore() ?? requestDatabase.getStore()?.db ?? target
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

export function createRequestDatabaseScope(connectionString: string) {
  const requestPool = createPool(connectionString)
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
