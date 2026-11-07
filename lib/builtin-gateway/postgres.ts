import { randomUUID } from 'node:crypto'
import { Client, type ClientConfig } from 'pg'
import { CodedError } from '@mikka/protocol/coded-error'
import { directPoolOptions } from '../../scripts/postgres-connection.mjs'
import { LIVE_CHANNEL, LIVE_ID, liveInvalidations } from '../live/events'
import type { GatewayBus, GatewayMessage } from './hub'

const CHANNEL = 'mikka_builtin_gateway_v1'
const CRON_LOCK = 1_561_001

/** Reject malformed notifications even from another process sharing this DB. */
export function gatewayMessage(value: unknown): GatewayMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (item.type === 'live' && typeof item.key === 'string' && LIVE_CHANNEL.test(item.key)) {
    const events = liveInvalidations(item.events, true)
    return events ? { type: 'live', key: item.key, events } : null
  }
  if (item.type === 'presence' && typeof item.request === 'string' && LIVE_ID.test(item.request)
    && typeof item.seen === 'number' && Number.isSafeInteger(item.seen) && item.seen > 0) {
    return { type: 'presence', request: item.request, seen: item.seen }
  }
  if (typeof item.key !== 'string' || !LIVE_ID.test(item.key)) return null
  if (item.type === 'work') return { type: 'work', key: item.key }
  if (item.type === 'probe' && typeof item.request === 'string' && LIVE_ID.test(item.request)) return { type: 'probe', key: item.key, request: item.request }
  if (item.type === 'claim' && typeof item.connection === 'string' && LIVE_ID.test(item.connection)) {
    return { type: 'claim', key: item.key, connection: item.connection }
  }
  return null
}

/** One direct PostgreSQL session per app replica. There is no heartbeat query
 * or reconnect poll: the next socket, write or scheduled job reconnects it. */
export class PostgresGatewayBus implements GatewayBus {
  private node = randomUUID()
  private client?: Client
  private connecting?: Promise<void>
  private listeners = new Set<{ receive: (message: GatewayMessage) => void; lost: () => void }>()
  private leader = false
  private stopped = false

  constructor(private options: ClientConfig) {}

  subscribe(receive: (message: GatewayMessage) => void, lost: () => void) {
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
    const client = new Client({ ...directPoolOptions(this.options), connectionTimeoutMillis: 5_000, application_name: 'mikka-builtin-gateway' })
    const lost = () => {
      if (this.client !== client) return
      this.client = undefined
      this.leader = false
      for (const listener of this.listeners) listener.lost()
      void client.end().catch(() => {})
    }
    client.on('error', lost)
    client.on('end', lost)
    client.on('notification', notification => {
      if (notification.channel !== CHANNEL || !notification.payload) return
      try {
        const envelope = JSON.parse(notification.payload)
        const message = gatewayMessage(envelope.message)
        if (envelope.node === this.node && message?.type !== 'claim') return
        if (message) for (const listener of this.listeners) listener.receive(message)
      } catch { /* malformed notifications have no authority */ }
    })
    try {
      await client.connect()
      await client.query(`LISTEN ${CHANNEL}`)
      if (this.stopped) { await client.end(); throw new CodedError('BUILTIN_GATEWAY_STOPPED') }
      this.client = client
    } catch (error) { await client.end().catch(() => {}); throw error }
  }

  async publish(message: GatewayMessage) {
    await this.ready()
    // A maximum 16-key live batch is below PostgreSQL's 8 KiB NOTIFY bound.
    await this.client!.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ node: this.node, message })])
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
    await client?.end()
  }
}
