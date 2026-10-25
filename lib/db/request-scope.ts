import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { mikkaDatabaseURL } from './config'
import { deviceScopedPool } from './device-scope'

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

export const pool = new Proxy(defaultPool, {
  get(target, property) {
    const current = deviceScopedPool(requestDatabase.getStore()?.pool ?? target)
    const value = Reflect.get(current, property, current)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

const scopedDatabases = new WeakMap<Pool, typeof defaultDatabase>()

export const db = new Proxy(defaultDatabase, {
  get(target, property) {
    const currentScope = requestDatabase.getStore()
    const base = currentScope?.pool ?? defaultPool
    const guarded = deviceScopedPool(base)
    let current = currentScope?.db ?? target
    if (guarded !== base) {
      let database = scopedDatabases.get(guarded)
      if (!database) { database = createDatabase(guarded); scopedDatabases.set(guarded, database) }
      current = database
    }
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
