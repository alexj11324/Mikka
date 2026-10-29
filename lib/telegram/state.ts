import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool, PoolClient } from 'pg'
import { createPostgresState } from '@chat-adapter/state-pg'

/** Chat SDK state joins the held reply transaction instead of borrowing a
 * second APP connection while source and account authorization locks are held. */
export function createTelegramState(pool: Pool) {
  const scope = new AsyncLocalStorage<PoolClient>()
  const scoped = new Proxy(pool, { get(target, property) {
    if (property === 'query' && scope.getStore()) return scope.getStore()!.query.bind(scope.getStore()!)
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return {
    adapter: createPostgresState({ client: scoped, autoCreateSchema: false, keyPrefix: 'mikka' }),
    withClient: <T>(client: PoolClient, work: () => Promise<T>) => scope.run(client, work),
  }
}
