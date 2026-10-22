import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'

function createPool(connectionString = process.env.MIKKA_DATABASE_URL ?? process.env.ORVILO_DATABASE_URL) {
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

export const pool = new Proxy(defaultPool, {
  get(target, property) {
    const current = requestDatabase.getStore()?.pool ?? target
    const value = Reflect.get(current, property, current)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

export const db = new Proxy(defaultDatabase, {
  get(target, property) {
    const current = requestDatabase.getStore()?.db ?? target
    const value = Reflect.get(current, property, current)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

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
