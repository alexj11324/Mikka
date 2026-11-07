import { createHash, randomUUID } from 'node:crypto'
import { Client, type ClientConfig, type QueryConfig, type QueryResultRow } from 'pg'
import { CodedError } from '@mikka/protocol/coded-error'
import { directPoolOptions } from '../../scripts/postgres-connection.mjs'
import { LIVE_CHANNEL, LIVE_ID, liveInvalidations } from '../live/events'
import { PRESENCE_MAX_DEVICES } from '../live/presence'
import { liveSessionIdValid } from '../live/session-ticket'
import type { GatewayBus, GatewayMessage } from './hub'
import { cancelGatewayQuery, type BackendKey } from './postgres-cancel'

const CHANNEL = 'mikka_builtin_gateway_v1'
const CRON_LOCK = 1_561_001
export const MAX_PRESENCE_SOURCES = 32
// Negative 63-bit session keys are separate from the positive cron lock. The
// source UUID is fresh for every physical LISTEN session.
const sourceLock = (source: string) => BigInt.asIntN(64, createHash('sha256').update(source).digest().readBigUInt64BE(0) | (1n << 63n)).toString()
type SourceWatch = { client: Client; options: ClientConfig; listeners: Set<() => void>; ready: Promise<void>; closed: boolean;
  backend?: BackendKey; response?: Promise<void>; queryRunning?: boolean; transportLost: boolean; closing?: Promise<void> }

function watchedQuery<R extends QueryResultRow>(watch: SourceWatch, query: QueryConfig) {
  // Unlike node-pg's optional local query timeout, ReadyForQuery confirms that
  // the server finished the statement. Cancellation cleanup must wait for it.
  watch.queryRunning = true
  watch.response = new Promise(resolve => watch.client.connection.once('readyForQuery', () => { watch.queryRunning = false; resolve() }))
  return watch.client.query<R>(query)
}

/** Reject malformed notifications even from another process sharing this DB. */
export function gatewayMessage(value: unknown): GatewayMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (item.type === 'session_revoked' && liveSessionIdValid(item.sessionId)) return { type: 'session_revoked', sessionId: item.sessionId }
  if (item.type === 'live_revoked' && typeof item.key === 'string' && LIVE_CHANNEL.test(item.key)) return { type: 'live_revoked', key: item.key }
  if (item.type === 'live' && typeof item.key === 'string' && LIVE_CHANNEL.test(item.key)) {
    const events = liveInvalidations(item.events, true)
    return events ? { type: 'live', key: item.key, events } : null
  }
  if (item.type === 'presence' && typeof item.request === 'string' && LIVE_ID.test(item.request)
    && typeof item.seen === 'number' && Number.isSafeInteger(item.seen) && item.seen > 0) {
    return { type: 'presence', request: item.request, seen: item.seen }
  }
  if (item.type === 'inspect' && typeof item.request === 'string' && LIVE_ID.test(item.request)
    && Array.isArray(item.keys) && item.keys.length > 0 && item.keys.length <= PRESENCE_MAX_DEVICES
    && item.keys.every(key => typeof key === 'string' && LIVE_ID.test(key)) && new Set(item.keys).size === item.keys.length) {
    return { type: 'inspect', request: item.request, keys: item.keys }
  }
  if (item.type === 'snapshot' && typeof item.request === 'string' && LIVE_ID.test(item.request)
    && Array.isArray(item.devices) && item.devices.length > 0 && item.devices.length <= PRESENCE_MAX_DEVICES) {
    const devices = []
    for (const device of item.devices) {
      if (!device || typeof device.key !== 'string' || !LIVE_ID.test(device.key)
        || typeof device.connection !== 'string' || !LIVE_ID.test(device.connection)
        || typeof device.seen !== 'number' || !Number.isSafeInteger(device.seen) || device.seen <= 0 || typeof device.online !== 'boolean') return null
      devices.push({ key: device.key, connection: device.connection, seen: device.seen, online: device.online })
    }
    if (new Set(devices.map(device => device.key)).size !== devices.length) return null
    return { type: 'snapshot', request: item.request, devices }
  }
  if (typeof item.key !== 'string' || !LIVE_ID.test(item.key)) return null
  if (item.type === 'work') return { type: 'work', key: item.key }
  if (item.type === 'probe' && typeof item.request === 'string' && LIVE_ID.test(item.request)) return { type: 'probe', key: item.key, request: item.request }
  if (item.type === 'claim' && typeof item.connection === 'string' && LIVE_ID.test(item.connection)) {
    if (item.seen !== undefined && (typeof item.seen !== 'number' || !Number.isSafeInteger(item.seen) || item.seen <= 0)) return null
    return { type: 'claim', key: item.key, connection: item.connection, ...(typeof item.seen === 'number' ? { seen: item.seen } : {}) }
  }
  if (item.type === 'device_state' && typeof item.connection === 'string' && LIVE_ID.test(item.connection)
    && typeof item.seen === 'number' && Number.isSafeInteger(item.seen) && item.seen > 0 && typeof item.online === 'boolean') {
    return { type: 'device_state', key: item.key, connection: item.connection, seen: item.seen, online: item.online }
  }
  return null
}

/** One direct PostgreSQL session per app replica. There is no heartbeat query
 * or reconnect poll: the next socket, write or scheduled job reconnects it. */
export class PostgresGatewayBus implements GatewayBus {
  private node = randomUUID()
  private client?: Client
  private connecting?: Promise<void>
  private listeners = new Set<{ receive: (message: GatewayMessage, source?: string) => void; lost: () => void }>()
  private sources = new Map<string, SourceWatch>()
  private closing = new Set<SourceWatch>()
  private leader = false
  private stopped = false

  constructor(private options: ClientConfig, private makeClient = (options: ClientConfig) => new Client(options),
    private cancelQuery = cancelGatewayQuery) {}

  subscribe(receive: (message: GatewayMessage, source?: string) => void, lost: () => void) {
    const listener = { receive, lost }
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async ready() {
    if (this.stopped) throw new CodedError('BUILTIN_GATEWAY_STOPPED')
    if (this.client) return
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => { this.connecting = undefined })
    }
    await this.connecting
  }

  private async connect() {
    const client = this.makeClient({ ...directPoolOptions(this.options), connectionTimeoutMillis: 5_000, application_name: 'mikka-builtin-gateway' })
    const source = randomUUID()
    const lost = () => this.lost(client)
    client.on('error', lost)
    client.on('end', lost)
    client.on('notification', notification => {
      if (this.client !== client || notification.channel !== CHANNEL || !notification.payload) return
      try {
        const envelope = JSON.parse(notification.payload)
        const message = gatewayMessage(envelope.message)
        if (typeof envelope.node !== 'string' || !LIVE_ID.test(envelope.node)) return
        if (envelope.node === this.node && message?.type !== 'claim') return
        if (message) for (const listener of this.listeners) listener.receive(message, envelope.node)
      } catch { /* malformed notifications have no authority */ }
    })
    try {
      await client.connect()
      const lease = await client.query<{ held: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS held', [sourceLock(source)])
      if (!lease.rows[0]?.held) throw new CodedError('BUILTIN_GATEWAY_LEASE_UNAVAILABLE')
      await client.query(`LISTEN ${CHANNEL}`)
      if (this.stopped) { await client.end(); throw new CodedError('BUILTIN_GATEWAY_STOPPED') }
      this.node = source
      this.client = client
    } catch (error) { await client.end().catch(() => {}); throw error }
  }

  async publish(message: GatewayMessage) {
    await this.ready()
    // A maximum 16-key live batch is below PostgreSQL's 8 KiB NOTIFY bound.
    const client = this.client!
    try { await client.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ node: this.node, message })]) }
    catch (error) { this.lost(client); throw error }
  }

  /** Two reads per connection, at upgrade/open. No session polling or per-frame SQL. */
  async authorizeSession(sessionId: string): Promise<boolean> {
    if (!liveSessionIdValid(sessionId)) return false
    await this.ready()
    const client = this.client!
    try {
      const { rows } = await client.query<{ active: boolean }>('SELECT EXISTS (SELECT 1 FROM "session" WHERE id = $1 AND "expiresAt" > now()) AS active', [sessionId])
      return this.client === client && rows[0]?.active === true
    } catch (error) { this.lost(client); throw error }
  }

  private lost(client: Client) {
    if (this.client !== client) return
    this.client = undefined
    this.leader = false
    for (const listener of this.listeners) listener.lost()
    for (const [source, watch] of this.sources) this.closeSource(source, watch, true)
    // Releasing this session's exclusive lease also invalidates its remote
    // observers when a publish fails but the TCP connection is still alive.
    void client.end().catch(() => {})
  }

  /** One bounded, shared waiter per observed remote source. An idle observer
   * holds a blocked lock query; no timer, heartbeat query or application row. */
  async observe(source: string, lost: () => void, signal?: AbortSignal): Promise<() => void> {
    if (!LIVE_ID.test(source) || this.stopped || !this.client || signal?.aborted) throw new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE')
    if (source === this.node) return () => {} // this hub's LISTEN-loss handler closes its sockets
    let watch = this.sources.get(source)
    if (!watch) {
      if (this.sources.size + this.closing.size >= MAX_PRESENCE_SOURCES) throw new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE')
      const options = { ...directPoolOptions(this.options), connectionTimeoutMillis: 5_000,
        application_name: `mikka-gateway-watch:${source}`, statement_timeout: 0, query_timeout: 0, lock_timeout: 0 }
      const client = this.makeClient(options)
      watch = { client, options, listeners: new Set(), ready: Promise.resolve(), closed: false, transportLost: false }
      this.sources.set(source, watch)
      const current = watch
      const failed = () => this.closeSource(source, current, true)
      const disconnected = () => { if (!current.closed) current.transportLost = true; failed() }
      client.on('error', disconnected)
      client.on('end', disconnected)
      client.connection.once('backendKeyData', (key: BackendKey) => { current.backend = { processID: key.processID, secretKey: key.secretKey } })
      watch.ready = (async () => {
        try {
          await client.connect()
          if (current.closed) throw new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE')
          // Only this dedicated session checks its TCP socket inside PG. This
          // releases a blocked backend after an observer process dies; it adds
          // no application SQL polling or heartbeat writes. Network blackholes
          // still depend on the kernel's TCP failure detection.
          const setup = { text: 'SET statement_timeout = 0; SET lock_timeout = 0; SET client_connection_check_interval = 1000; SET client_min_messages = notice', query_timeout: 5_000 }
          await watchedQuery(current, setup)
          if (current.closed) throw new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE')
          const initial = { text: 'SELECT pg_try_advisory_lock_shared($1::bigint) AS absent', values: [sourceLock(source)], query_timeout: 5_000 }
          const result = await watchedQuery<{ absent: boolean }>(current, initial)
          if (result.rows[0]?.absent !== false || current.closed) {
            // If acquired, immediately ending the session releases our shared
            // lock. It must never masquerade as, or extend, the source lease.
            throw new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE')
          }
          // CancelRequest is ignored while a backend is idle. Queuing a local
          // write alone cannot prove PG has started it. A notice flushed from
          // inside the same command acknowledges that it is cancellable before
          // observe returns; the command then waits on the source's lease.
          // The interpolated key is a derived signed bigint, never caller SQL.
          const started = Promise.withResolvers<void>()
          const announced = (notice: { message?: string }) => {
            if (notice.message === 'mikka_gateway_wait_started') started.resolve()
          }
          let startTimer: ReturnType<typeof setTimeout> | undefined
          client.on('notice', announced)
          try {
            const waiting = watchedQuery(current, { text: `DO $mikka$ BEGIN
              RAISE NOTICE 'mikka_gateway_wait_started';
              PERFORM pg_advisory_lock_shared('${sourceLock(source)}'::bigint);
            END $mikka$` })
            // Source death between try and wait still revokes the same watch.
            void waiting.then(failed, failed)
            await Promise.race([started.promise, waiting, new Promise<never>((_, reject) => {
              startTimer = setTimeout(() => reject(new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE')), 5_000)
            })])
          } finally { clearTimeout(startTimer); client.off('notice', announced) }
        } catch (error) { failed(); throw error }
      })()
    }
    const current = watch
    // Each call owns a distinct reference even when it reuses the callback.
    const listener = () => lost()
    current.listeners.add(listener)
    const release = () => {
      signal?.removeEventListener('abort', release)
      current.listeners.delete(listener)
      if (!current.listeners.size) this.closeSource(source, current, false)
    }
    signal?.addEventListener('abort', release, { once: true })
    try { await current.ready }
    catch (error) { release(); throw error }
    if (current.closed || signal?.aborted) { release(); throw new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE') }
    return release
  }

  private closeSource(source: string, watch: SourceWatch, notify: boolean) {
    if (watch.closed) return
    watch.closed = true
    if (this.sources.get(source) === watch) this.sources.delete(source)
    const listeners = [...watch.listeners]
    watch.listeners.clear()
    // A client-side end alone cannot interrupt a blocked PG backend. Cancel
    // this exact session, wait for its query response, then terminate it. Keep
    // the capacity reservation until cleanup is confirmed; transport failure
    // conservatively retains it for this bus's lifetime.
    this.closing.add(watch)
    watch.closing = this.closeWaiter(watch)
    if (notify) for (const listener of listeners) listener()
  }

  private async closeWaiter(watch: SourceWatch) {
    let confirmed = !watch.transportLost
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (watch.backend && watch.response && watch.queryRunning && !watch.transportLost) {
        await this.cancelQuery(watch.options, watch.backend)
        await Promise.race([watch.response, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CodedError('BUILTIN_GATEWAY_CANCEL_UNAVAILABLE')), 5_000)
        })])
      }
    } catch { confirmed = false }
    finally {
      clearTimeout(timer)
      await watch.client.end().catch(() => { confirmed = false })
      if (confirmed) this.closing.delete(watch)
    }
  }

  async isSchedulerLeader() {
    await this.ready()
    if (!this.leader) {
      const { rows } = await this.client!.query<{ leader: boolean }>('SELECT pg_try_advisory_lock($1) AS leader', [CRON_LOCK])
      this.leader = rows[0]?.leader === true
    }
    return this.leader
  }

  async stop() {
    this.stopped = true
    await this.connecting?.catch(() => {})
    const client = this.client
    this.client = undefined
    this.leader = false
    for (const listener of this.listeners) listener.lost()
    this.listeners.clear()
    const watchers = [...this.sources.entries()]
    for (const [source, watch] of watchers) this.closeSource(source, watch, false)
    await client?.end()
    await Promise.all([...this.closing].map(watch => watch.closing))
  }
}
