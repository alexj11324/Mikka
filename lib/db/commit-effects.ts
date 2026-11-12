import { Pool, type PoolClient, type QueryResult } from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'

type Effect = () => void | Promise<void>
type State = { active: boolean; effects: Map<string, Effect>; savepoints: { name: string; effects: Map<string, Effect> }[]; scope: object }
const STATE = Symbol.for('mikka.database.commitEffects')
/** Request proxies expose only the executor used for commit observation. */
export const COMMIT_EXECUTOR = Symbol.for('mikka.database.commitExecutor')
const COMMIT_CONTEXT = Symbol.for('mikka.database.commitContext')
type ObservedClient = PoolClient & { [STATE]?: State }
const pools = new WeakSet<Pool>()
const isolatedRestore = new AsyncLocalStorage<ReadonlySet<object>>()

/** Replaying a deletion journal into a quarantined database must not wake live consumers. */
export function withoutCommitEffectsForRestore<T>(targets: readonly Pool[], work: () => T): T {
  return isolatedRestore.run(new Set(targets.map(commitExecutor)), work)
}

const reset = (state: State) => { state.active = false; state.effects.clear(); state.savepoints = [] }
const run = (effect: Effect) => {
  // A best-effort invalidation cannot turn a successful COMMIT into a failed write.
  try { Promise.resolve(effect()).catch(() => console.warn('[live] committed invalidation failed')) }
  catch { console.warn('[live] committed invalidation failed') }
}

/** Attach before BEGIN, below the existing device-authority wrapper. No SQL is added. */
export function observeCommitEffects(client: PoolClient, scope: object = client) {
  const observed = client as ObservedClient
  if (observed[STATE]) { observed[STATE].scope = scope; return }
  const state: State = { active: false, effects: new Map(), savepoints: [], scope }
  observed[STATE] = state
  const query = client.query.bind(client) as (...args: unknown[]) => unknown
  const settled = (text: string, result: unknown) => {
    const command = text.trim().replace(/;$/, '').trim()
    const results = (Array.isArray(result) ? result : [result]) as QueryResult[]
    const last = results.at(-1)?.command
    if (/^(?:begin|start\s+transaction)\b/i.test(command)) {
      reset(state); state.active = true
    } else if (/^(?:commit|end)(?:\s|$)/i.test(command)) {
      const effects = last === 'COMMIT' ? [...state.effects.values()] : []
      reset(state)
      if (/\band\s+chain$/i.test(command)) state.active = true
      for (const effect of effects) run(effect)
    } else {
      const rollback = command.match(/^rollback\s+to\s+(?:savepoint\s+)?("(?:[^"]|"")+"|[\w]+)$/i)
      const release = command.match(/^release\s+(?:savepoint\s+)?("(?:[^"]|"")+"|[\w]+)$/i)
      const savepoint = command.match(/^savepoint\s+("(?:[^"]|"")+"|[\w]+)$/i)
      const name = (raw: string) => raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase()
      if (rollback || release) {
        const wanted = name((rollback ?? release)![1])
        const index = state.savepoints.findLastIndex(point => point.name === wanted)
        if (index >= 0) {
          if (rollback) state.effects = new Map(state.savepoints[index].effects)
          state.savepoints.length = index + (rollback ? 1 : 0)
        }
      } else if (/^(?:rollback|abort)(?:\s|$)/i.test(command)) {
        reset(state)
        if (/\band\s+chain$/i.test(command)) state.active = true
      } else if (savepoint) {
        state.savepoints.push({ name: name(savepoint[1]), effects: new Map(state.effects) })
      }
    }
  }
  ;(client as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0]
    const text = typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text
    if (typeof text !== 'string') return query(...args)
    const failed = () => { if (/^\s*(?:commit|end)\b/i.test(text)) reset(state) }
    const callback = args.at(-1)
    if (typeof callback === 'function') {
      return query(...args.slice(0, -1), (error: unknown, result: unknown) => {
        if (error) failed(); else settled(text, result)
        return callback(error, result)
      })
    }
    const pending = query(...args)
    return pending instanceof Promise ? pending.then(result => { settled(text, result); return result }, error => { failed(); throw error }) : pending
  }
}

export function observePoolCommits(pool: Pool) {
  // Request-routed proxies expose an already observed physical executor.
  if (pools.has(pool) || (pool as Pool & { [COMMIT_EXECUTOR]?: unknown })[COMMIT_EXECUTOR]) return
  pools.add(pool)
  pool.on('connect', client => observeCommitEffects(client, pool))
  pool.on('acquire', client => observeCommitEffects(client, pool))
  pool.on('release', (_error, client) => { const state = (client as ObservedClient)[STATE]; if (state) reset(state) })
}

export function hasCommitEffect(client: PoolClient, key: string) {
  return (client as ObservedClient)[STATE]?.effects.has(key) ?? false
}

/** Only explicit writers register effects. Reads and rolled-back savepoints send nothing. */
export function afterCommit(client: PoolClient, key: string, effect: Effect) {
  const state = (client as ObservedClient)[STATE]
  if (!state) throw new Error('Commit effects require an observed database client')
  const restored = isolatedRestore.getStore()
  if (restored?.has(state.scope) || restored?.has(client)) return
  // COMMIT can be issued after the originating request context has exited.
  const committed = AsyncLocalStorage.bind(effect)
  if (state.active) state.effects.set(key, committed)
  else run(committed) // An autocommitted write has already succeeded.
}

/** The pinned node-postgres Drizzle transaction holds the same observed client
 * for every nested savepoint. Register below Drizzle, not after a nested
 * transaction callback, which can return before the outer COMMIT. */
export function afterDatabaseCommit(executor: object, key: string, effect: Effect) {
  const client = commitExecutor(executor)
  const context = (executor as { [COMMIT_CONTEXT]?: ReturnType<typeof AsyncLocalStorage.snapshot> })[COMMIT_CONTEXT] ?? AsyncLocalStorage.snapshot()
  const committed = () => context(effect)
  if ((client as ObservedClient)[STATE]) afterCommit(client as PoolClient, key, committed)
  else if (client instanceof Pool) {
    // The caller has awaited its autocommitted statement.
    if (!isolatedRestore.getStore()?.has(client)) run(committed)
  } else throw new Error('Commit effects require an observed node-postgres executor')
}

/** A service retaining a bound query must retain its executor and request
 * context at the same instant. Later callbacks cannot guess its transaction,
 * database or device authority from the query function. */
type AppTransaction = Parameters<Parameters<typeof import('./request-scope').db.transaction>[0]>[0]
export function captureDatabaseQuery(executor: Pick<Pool | PoolClient, 'query'> | AppTransaction) {
  // Keep the actual authority-wrapped session client. COMMIT_EXECUTOR names
  // the observer for notifications and must never be used to run queries.
  const direct = executor as Pick<Pool | PoolClient, 'query'>
  const target = typeof direct.query === 'function' ? direct
    : (executor as unknown as {session:{client:PoolClient}}).session.client
  return { query: AsyncLocalStorage.bind(target.query.bind(target)),
    [COMMIT_EXECUTOR]: commitExecutor(executor), [COMMIT_CONTEXT]: AsyncLocalStorage.snapshot() }
}

/** Opaque identity only: batching cannot mix requests to separate databases. */
export function databaseCommitScope(executor: object): object {
  const client = commitExecutor(executor)
  const scope = (client as ObservedClient)[STATE]?.scope
  if (scope) return scope
  if (client instanceof Pool) return client
  throw new Error('Commit effects require an observed node-postgres executor')
}

function commitExecutor(executor: object): ObservedClient | Pool {
  const client = ((executor as { session?: { client?: unknown } }).session?.client ?? executor) as ObservedClient | Pool
  return (client as { [COMMIT_EXECUTOR]?: ObservedClient | Pool })[COMMIT_EXECUTOR] ?? client
}
