import type { Pool, PoolClient, QueryResult } from 'pg'

type Effect = () => void | Promise<void>
type State = { active: boolean; effects: Map<string, Effect>; savepoints: { name: string; effects: Map<string, Effect> }[] }
const STATE = Symbol.for('mikka.database.commitEffects')
type ObservedClient = PoolClient & { [STATE]?: State }
const pools = new WeakSet<Pool>()

const reset = (state: State) => { state.active = false; state.effects.clear(); state.savepoints = [] }
const run = (effect: Effect) => {
  // A best-effort invalidation cannot turn a successful COMMIT into a failed write.
  try { Promise.resolve(effect()).catch(() => console.warn('[live] committed invalidation failed')) }
  catch { console.warn('[live] committed invalidation failed') }
}

/** Attach before BEGIN, below the existing device-authority wrapper. No SQL is added. */
export function observeCommitEffects(client: PoolClient) {
  const observed = client as ObservedClient
  if (observed[STATE]) return
  const state: State = { active: false, effects: new Map(), savepoints: [] }
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
  if (pools.has(pool)) return
  pools.add(pool)
  pool.on('connect', observeCommitEffects)
  pool.on('acquire', observeCommitEffects)
  pool.on('release', (_error, client) => { const state = (client as ObservedClient)[STATE]; if (state) reset(state) })
}

export function hasCommitEffect(client: PoolClient, key: string) {
  return (client as ObservedClient)[STATE]?.effects.has(key) ?? false
}

/** Only explicit writers register effects. Reads and rolled-back savepoints send nothing. */
export function afterCommit(client: PoolClient, key: string, effect: Effect) {
  const state = (client as ObservedClient)[STATE]
  if (!state) throw new Error('Commit effects require an observed database client')
  if (state.active) state.effects.set(key, effect)
  else run(effect) // An autocommitted write has already succeeded.
}
