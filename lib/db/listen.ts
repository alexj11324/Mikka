import { Pool, type Notification, type PoolClient, type PoolConfig } from 'pg'
import { directPoolOptions } from '../../scripts/postgres-connection.mjs'

/** Postgres NOTIFY channels: fixed identifiers, payloads are row ids only (#1212). */
export const GROUP_TURN_STOP_CHANNEL = 'mikka_group_turn_stop'
export const COORDINATOR_LEASE_CHANNEL = 'mikka_coordinator_lease'
type Channel = typeof GROUP_TURN_STOP_CHANNEL | typeof COORDINATOR_LEASE_CHANNEL

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
