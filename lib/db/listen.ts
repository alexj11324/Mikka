import { Pool, type Notification, type PoolClient, type PoolConfig } from 'pg'
import { directPoolOptions } from '../../scripts/postgres-connection.mjs'

/** Postgres NOTIFY channels: fixed identifiers, payloads are row ids only (#1212). */
export const GROUP_TURN_STOP_CHANNEL = 'mikka_group_turn_stop'
export const COORDINATOR_LEASE_CHANNEL = 'mikka_coordinator_lease'
/** A device may have work: payload is the device id, or `token:<id>` for a revoked credential. */
export const DEVICE_WORK_CHANNEL = 'mikka_device_work'
/** App reply/scope and workspace membership triggers; ids only, delivered at commit. */
export const MCP_REPLY_CHANNEL = 'mikka_mcp_reply'
/** One run's Ask-mode decision: payload is the approval id. */
export const RUN_APPROVAL_CHANNEL = 'mikka_run_approval'
type Channel = typeof GROUP_TURN_STOP_CHANNEL | typeof COORDINATOR_LEASE_CHANNEL | typeof DEVICE_WORK_CHANNEL | typeof MCP_REPLY_CHANNEL | typeof RUN_APPROVAL_CHANNEL

/** Sent with the writer's transaction: PostgreSQL delivers it only on COMMIT.
 * NOTIFY works through the Neon pooler; only LISTEN needs a direct session. */
export async function notifyChannel(database: Pick<PoolClient, 'query'>, channel: Channel, payloads: readonly string[]) {
  if (payloads.length) await database.query('SELECT pg_notify($1, payload) FROM unnest($2::text[]) AS payload', [channel, [...new Set(payloads)]])
}

/** Payloads heard on `channel` over a client that already holds a direct
 * session. A payload heard before anyone waits for it is kept, so a waiter
 * that registers late still learns of it at once. */
export async function listenOn(client: PoolClient, channel: Channel) {
  const heard = new Set<string>()
  const waiters = new Map<string, Set<() => void>>()
  const onNotification = (message: Notification) => {
    if (message.channel !== channel || !message.payload) return
    heard.add(message.payload)
    for (const wake of waiters.get(message.payload) ?? []) wake()
  }
  client.on('notification', onNotification)
  try { await client.query(`LISTEN ${channel}`) }
  catch (error) { client.off('notification', onNotification); throw error }
  return {
    /** Calls `heard` on the next notification for `payload`, or now if one already came. */
    on(payload: string, wake: () => void) {
      if (heard.has(payload)) queueMicrotask(wake)
      const set = waiters.get(payload) ?? new Set()
      set.add(wake)
      waiters.set(payload, set)
      return () => { set.delete(wake); if (!set.size) waiters.delete(payload) }
    },
    /** Forgets what was heard for `payload`, before a fresh read. */
    consume(payload: string) { return heard.delete(payload) },
    stop() { client.off('notification', onNotification) },
  }
}
export type Listener = Awaited<ReturnType<typeof listenOn>>

/** One short-lived direct session that only listens. Close it when done. */
export async function openListener(database: { options: PoolConfig }, channel: Channel) {
  const sessions = new Pool({ ...directPoolOptions(database.options), max: 1, connectionTimeoutMillis: 5_000, application_name: 'mikka-listen' })
  sessions.on('error', () => {})
  const client = await sessions.connect().catch(async error => { await sessions.end(); throw error })
  client.on('error', () => {})
  const close = async () => { client.release(true); await sessions.end() }
  try { return { ...await listenOn(client, channel), close } }
  catch (error) { await close(); throw error }
}

/** Resolves on the next notification for `payload`, or after `ms`. */
export function nextNotification(listener: Pick<Listener, 'on'> | null, payload: string, ms: number) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(done, Math.max(0, ms))
    const off = listener?.on(payload, done) ?? (() => {})
    function done() { clearTimeout(timer); off(); resolve() }
  })
}

/** Keep a shared session this long after its last waiter, so back-to-back long polls reuse it. */
const SHARED_IDLE_MS = 10_000

type SharedSubscriber = { keys: ReadonlySet<string>; notify: () => void; lost: () => void }
type SharedSession = { ready: Promise<boolean>; subscribers: Set<SharedSubscriber>; idle?: ReturnType<typeof setTimeout>; close: () => Promise<void> }
const sharedSessions = new Map<string, SharedSession>()

/** A waiter on a shared LISTEN session. Register before the read it guards:
 * a notification that lands during that read makes the next wait return at once. */
export type SharedSubscription = {
  /** Forget what was heard, right before a fresh read. */
  reset(): void
  /** Resolves on a notification for one of the keys (or one heard since reset), after `ms`, or on abort. */
  next(ms: number, signal?: AbortSignal): Promise<'notified' | 'timeout' | 'aborted'>
  /** True once the shared session dropped: the caller falls back to its timer. */
  readonly lost: boolean
  close(): void
}

function openSharedSession(database: { options: PoolConfig }, channel: Channel, id: string): SharedSession {
  const subscribers = new Set<SharedSubscriber>()
  let sessions: Pool | undefined, client: PoolClient | undefined, closed = false
  const drop = () => {
    if (sharedSessions.get(id) === session) sharedSessions.delete(id)
    for (const subscriber of subscribers) subscriber.lost()
  }
  const close = async () => {
    if (closed) return
    closed = true
    if (sharedSessions.get(id) === session) sharedSessions.delete(id)
    client?.release(true)
    await sessions?.end().catch(() => {})
  }
  const ready = (async () => {
    sessions = new Pool({ ...directPoolOptions(database.options), max: 1, connectionTimeoutMillis: 5_000, application_name: 'mikka-listen',
      // Kernel probes, not SQL/application heartbeat. This improves detection
      // of a dead peer; it is not a delivery deadline or an authorization check.
      ...(channel === MCP_REPLY_CHANNEL ? { keepAlive: true, keepAliveInitialDelayMillis: 5_000, query_timeout: 5_000 } : {}),
    })
    sessions.on('error', () => {})
    client = await sessions.connect()
    client.on('error', () => { drop(); void close() })
    client.on('end', drop)
    client.on('notification', (message: Notification) => {
      if (message.channel !== channel || !message.payload) return
      for (const subscriber of subscribers) if (subscriber.keys.has(message.payload)) subscriber.notify()
    })
    await client.query(`LISTEN ${channel}`)
    if (closed) throw new Error('listener closed')
    return true
  })().catch(async () => { drop(); await close(); return false })
  const session: SharedSession = { ready, subscribers, close }
  return session
}

/**
 * Waits on `channel` for any of `keys` over one direct session per process,
 * shared by every concurrent waiter (a long poll per idle device must not hold
 * a database connection each). Null when LISTEN is unavailable.
 */
export async function subscribeShared(database: { options: PoolConfig }, channel: Channel, keys: readonly string[], signal?: AbortSignal): Promise<SharedSubscription | null> {
  if (signal?.aborted) return null
  const id = `${channel}:${String(database.options?.connectionString ?? database.options?.host ?? '')}:${String(database.options?.database ?? '')}`
  let session = sharedSessions.get(id)
  if (!session) { session = openSharedSession(database, channel, id); sharedSessions.set(id, session) }
  clearTimeout(session.idle)
  session.idle = undefined
  let heard = false, lost = false, wake: (() => void) | undefined
  const subscriber: SharedSubscriber = {
    keys: new Set(keys),
    notify: () => { heard = true; wake?.() },
    lost: () => { lost = true; heard = true; wake?.() },
  }
  session.subscribers.add(subscriber)
  const current = session
  const leave = () => {
    if (!current.subscribers.delete(subscriber) || current.subscribers.size) return
    clearTimeout(current.idle)
    current.idle = setTimeout(() => { if (!current.subscribers.size) void current.close() }, SHARED_IDLE_MS)
    current.idle.unref?.()
  }
  let cancel = () => {}
  const cancelled = new Promise<false>(resolve => {
    cancel = () => { leave(); resolve(false) }
    signal?.addEventListener('abort', cancel, { once: true })
  })
  let ready: boolean
  try { ready = await Promise.race([session.ready, cancelled]) }
  finally { signal?.removeEventListener('abort', cancel) }
  if (!ready || signal?.aborted) { leave(); return null }
  return {
    reset() { heard = false },
    get lost() { return lost },
    next(ms, signal) {
      return new Promise(resolve => {
        if (signal?.aborted) { resolve('aborted'); return }
        if (heard) { resolve('notified'); return }
        const done = (reason: 'notified' | 'timeout' | 'aborted') => { clearTimeout(timer); signal?.removeEventListener('abort', abort); wake = undefined; resolve(reason) }
        const abort = () => done('aborted')
        const timer = setTimeout(() => done('timeout'), Math.max(0, ms))
        wake = () => done('notified')
        signal?.addEventListener('abort', abort, { once: true })
      })
    },
    close: leave,
  }
}
