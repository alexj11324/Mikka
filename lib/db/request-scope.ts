import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { mikkaDatabaseURL } from './config'

function createPool(connectionString = mikkaDatabaseURL(process.env)) {
  return new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
}

function createDatabase(client: Pool) {
  return drizzle(client, { schema })
}

const globalDb = globalThis as unknown as { mikkaPool?: Pool }
const defaultPool = globalDb.mikkaPool ?? createPool()
if (process.env.NODE_ENV !== 'production') globalDb.mikkaPool = defaultPool
const defaultDatabase = createDatabase(defaultPool)
const requestDatabase = new AsyncLocalStorage<{ pool: Pool; db: typeof defaultDatabase }>()
type Transaction = Parameters<Parameters<typeof defaultDatabase.transaction>[0]>[0]
const transactionDatabase = new AsyncLocalStorage<Transaction>()

export const pool = new Proxy(defaultPool, {
  get(target, property) {
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
