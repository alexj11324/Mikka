import type { Pool, QueryResult } from 'pg'
import { inDatabaseTransaction } from './request-scope'

/**
 * Only plain reads are shared: a write, a row lock, a session setting or an
 * advisory lock always reaches the database, and clears what was shared.
 */
const READ = /^\s*(select|with)\b/i
const NOT_A_PLAIN_READ = /\b(insert|update|delete|merge|for\s+(no\s+key\s+)?update|for\s+(key\s+)?share|set_config|pg_advisory\w*|nextval|setval)\b/i

/**
 * One read-only operation's view of `pool` (one request: never kept or shared
 * between requests, so a revoked membership or a changed policy takes effect on
 * the next one). An identical statement with identical parameters runs once;
 * later callers get a copy of its rows. Settings and Agent Profile reads ask
 * the same credential, policy and device questions once per model or profile.
 * `connect()` and transactions are the pool's own, and any other statement
 * goes through unchanged and empties the shared reads.
 */
export function readOnce<P extends Pick<Pool, 'query'>>(pool: P): P {
  const shared = new Map<string, Promise<QueryResult>>()
  const query = (...args: unknown[]) => {
    const [statement, values] = args
    const text = typeof statement === 'string' ? statement : (statement as { text?: unknown } | null)?.text
    const plainRead = typeof text === 'string' && READ.test(text) && !NOT_A_PLAIN_READ.test(text)
    // A callback, a held transaction client or a cursor/stream config: not shareable.
    const shareable = plainRead && args.length <= 2 && typeof args[1] !== 'function' && !inDatabaseTransaction()
      && (typeof statement === 'string' || Object.keys(statement as object).every(key => ['text', 'values', 'rowMode', 'types', 'name'].includes(key)))
    if (!shareable) {
      if (!plainRead) shared.clear()
      return Reflect.apply(pool.query, pool, args)
    }
    const config: { values?: unknown; rowMode?: unknown } = typeof statement === 'string' ? { values } : statement as { values?: unknown; rowMode?: unknown }
    const key = JSON.stringify([text, config.values ?? values ?? null, config.rowMode ?? null])
    let result = shared.get(key)
    if (!result) {
      result = Reflect.apply(pool.query, pool, args) as Promise<QueryResult>
      shared.set(key, result)
      result.catch(() => { if (shared.get(key) === result) shared.delete(key) })
    }
    return result.then(value => ({ ...value, rows: structuredClone(value.rows) }))
  }
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'query') return query
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
