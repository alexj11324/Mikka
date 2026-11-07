import { randomUUID } from 'node:crypto'
import { CodedError } from '@mikka/protocol/coded-error'
import { liveInvalidations, liveReady, withoutRevisions, type LiveInvalidation } from '../live/events'
import { PRESENCE_ONLINE_MS, presenceCommand } from '../live/presence'
import { PresenceWatches, type DeviceSnapshot } from './presence'

export type GatewayPeer = { id: string; send(data: string): unknown; close(code: number, reason: string): unknown }
export type GatewaySocket = { kind: 'live' | 'device'; key: string; expiresAt: number; revisions: boolean; presence?: boolean; sessionId?: string }
export type GatewayPresence = { online: boolean; lastSeenAt: string | null }
export type GatewayMessage =
  | { type: 'session_revoked'; sessionId: string }
  | { type: 'live_revoked'; key: string }
  | { type: 'live'; key: string; events: LiveInvalidation[] }
  | { type: 'work'; key: string }
  | { type: 'claim'; key: string; connection: string; seen?: number }
  | { type: 'device_state'; key: string; connection: string; seen: number; online: boolean }
  | { type: 'probe'; key: string; request: string }
  | { type: 'presence'; request: string; seen: number }
  | { type: 'inspect'; keys: string[]; request: string }
  | { type: 'snapshot'; request: string; devices: Omit<DeviceSnapshot, 'source'>[] }

export interface GatewayBus {
  /** Claim messages are echoed to their publisher in the same commit order
   * seen by all replicas. Other messages exclude their publisher. */
  publish(message: GatewayMessage): Promise<void>
  subscribe(receive: (message: GatewayMessage, source?: string) => void, lost: () => void): () => void
  /** Observe the lifetime of a publishing LISTEN session, without polling. */
  observe?(source: string, lost: () => void, signal?: AbortSignal): Promise<() => void>
}
type Connection = { peer: GatewayPeer; socket: GatewaySocket; claimed: boolean; seen: number; online: boolean; authorized: boolean;
  source?: string; expiry?: ReturnType<typeof setTimeout>; stale?: ReturnType<typeof setTimeout> }
type PendingSnapshot = { keys: Set<string>; states: Map<string, DeviceSnapshot>; sent: boolean;
  timer?: ReturnType<typeof setTimeout>; finish(error?: Error): void }
const OFFLINE: GatewayPresence = { online: false, lastSeenAt: null }

/** Holds sockets, never user content or database-backed heartbeats. Postgres
 * carries only the same invalidation keys and device wake signals as Workers. */
export class GatewayHub {
  private connections = new Map<string, Connection>()
  private claims = new Map<string, Connection>()
  private pendingPresence = new Map<string, (seen: number) => void>()
  private pendingSnapshots = new Map<string, PendingSnapshot>()
  private presence: PresenceWatches
  private unsubscribe: () => void
  private revokedLive = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private bus: GatewayBus, private now = Date.now, secret = '', private authorizeSession?: (sessionId: string, channel: string) => Promise<boolean>) {
    this.presence = new PresenceWatches(secret, bus, now, (keys, signal) => this.snapshots(keys, signal),
      (peer, reply) => this.send(peer, JSON.stringify(reply)), (channel, home) => {
        this.receive({ type: 'live', key: channel, events: [{ kind: 'device_list', id: home }, { kind: 'thread_list', id: home }] })
      })
    this.unsubscribe = bus.subscribe((message, source) => this.receive(message, source), () => this.disconnect())
  }

  async authorize(socket: GatewaySocket): Promise<boolean> {
    if (socket.kind === 'live' && this.revokedLive.has(socket.key)) return false
    if (socket.kind !== 'live' || !socket.sessionId) return true
    if (!this.authorizeSession || socket.expiresAt <= this.now()) return false
    try { return await this.authorizeSession(socket.sessionId, socket.key) && !this.revokedLive.has(socket.key) }
    catch { return false } // An unavailable fresh authority never keeps a live capability open.
  }

  async open(peer: GatewayPeer, socket: GatewaySocket) {
    const connection: Connection = { peer, socket, claimed: false, seen: this.now(), online: false, authorized: !socket.sessionId }
    this.connections.set(peer.id, connection)
    if (socket.kind === 'live') {
      if (this.revokedLive.has(socket.key)) { this.remove(peer.id, 4001, 'live capability revoked'); return }
      if (socket.sessionId) {
        // Register before checking: a committed revoke during the await removes
        // this exact connection, and a late successful read cannot resurrect it.
        const allowed = await this.authorize(socket)
        if (this.connections.get(peer.id) !== connection) return
        if (!allowed) { this.remove(peer.id, 4001, 'session revoked'); return }
        connection.authorized = true
      }
      if (socket.expiresAt <= this.now()) { this.remove(peer.id, 4001, 'ticket expired'); return }
      connection.expiry = setTimeout(() => this.remove(peer.id, 4001, 'ticket expired'), socket.expiresAt - this.now())
      connection.expiry.unref?.()
      this.send(peer, JSON.stringify(liveReady(socket.revisions ? 2 : 1)))
      if (socket.presence && this.presence.supported) this.send(peer, JSON.stringify({ type: 'presence_ready', version: 1 }))
    } else {
      this.claims.set(peer.id, connection)
      const claim = { type: 'claim', key: socket.key, connection: peer.id, seen: connection.seen } as const
      try { await this.bus.publish(claim) }
      catch { this.claims.delete(peer.id); this.remove(peer.id, 1012, 'gateway unavailable') }
    }
  }

  message(peer: GatewayPeer, data: string) {
    const connection = this.connections.get(peer.id)
    if (!connection || !connection.authorized) return
    if (connection.socket.kind === 'live' && connection.socket.expiresAt <= this.now()) {
      this.remove(peer.id, 4001, 'ticket expired'); return
    }
    if (data === 'ping') {
      connection.seen = this.now(); this.send(peer, 'pong')
      if (this.connections.get(peer.id) !== connection) return
      if (connection.socket.kind === 'device' && connection.claimed) {
        if (!connection.online) { connection.online = true; this.deviceChanged(connection) }
        this.deviceDeadline(connection)
      }
      return
    }
    if (connection.socket.kind !== 'live' || !connection.socket.presence || data.length > 2048) return
    let command
    try { command = presenceCommand(JSON.parse(data)) } catch { return }
    if (command) return this.presence.command(peer, connection.socket, command)
  }

  close(peer: GatewayPeer) { this.remove(peer.id) }

  private remove(id: string, code?: number, reason = '', notify = true) {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    clearTimeout(connection.expiry)
    clearTimeout(connection.stale)
    this.presence.close(connection.peer)
    if (notify && connection.socket.kind === 'device' && connection.claimed && connection.online) {
      connection.online = false; this.deviceChanged(connection)
    }
    if (code !== undefined) { try { connection.peer.close(code, reason) } catch { /* already closed */ } }
  }

  private localPresence(key: string): number {
    let seen = 0
    for (const connection of this.connections.values()) {
      if (connection.socket.kind === 'device' && connection.socket.key === key && connection.claimed) seen = Math.max(seen, connection.seen)
    }
    return seen && this.now() - seen < PRESENCE_ONLINE_MS ? seen : 0
  }

  private deviceDeadline(connection: Connection) {
    clearTimeout(connection.stale)
    connection.stale = setTimeout(() => {
      if (this.connections.get(connection.peer.id) !== connection || !connection.claimed) return
      if (this.now() - connection.seen < PRESENCE_ONLINE_MS) { this.deviceDeadline(connection); return }
      if (connection.online) { connection.online = false; this.deviceChanged(connection) }
    }, Math.max(1, connection.seen + PRESENCE_ONLINE_MS - this.now()))
    connection.stale.unref?.()
  }

  private deviceChanged(connection: Connection) {
    const message = { type: 'device_state', key: connection.socket.key, connection: connection.peer.id,
      seen: connection.seen, online: connection.online } as const
    this.receive(message, connection.source)
    void this.bus.publish(message).catch(() => this.disconnect())
  }

  private localSnapshot(key: string): DeviceSnapshot | undefined {
    for (const connection of this.connections.values()) {
      if (connection.socket.kind === 'device' && connection.socket.key === key && connection.claimed && connection.source) {
        return { key, connection: connection.peer.id, source: connection.source, seen: connection.seen,
          online: connection.online && this.now() - connection.seen < PRESENCE_ONLINE_MS }
      }
    }
  }

  /** A watch first indexes its devices, then catches up through this bounded
   * request. A failed publish/LISTEN never becomes a covered offline result. */
  private snapshots(keys: string[], signal: AbortSignal): Promise<Map<string, DeviceSnapshot>> {
    if (signal.aborted) return Promise.reject(new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE'))
    const states = new Map<string, DeviceSnapshot>()
    for (const key of keys) { const state = this.localSnapshot(key); if (state) states.set(key, state) }
    if (states.size === keys.length) return Promise.resolve(states)
    const request = randomUUID()
    return new Promise((resolve, reject) => {
      const aborted = () => finish(new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE'))
      const finish = (error?: Error) => {
        const pending = this.pendingSnapshots.get(request)
        if (!pending || !this.pendingSnapshots.delete(request)) return
        clearTimeout(pending.timer)
        signal.removeEventListener('abort', aborted)
        if (error) reject(error); else resolve(states)
      }
      const pending: PendingSnapshot = { keys: new Set(keys), states, sent: false, finish }
      this.pendingSnapshots.set(request, pending)
      signal.addEventListener('abort', aborted, { once: true })
      void this.bus.publish({ type: 'inspect', keys: keys.filter(key => !states.has(key)), request }).then(() => {
        if (!this.pendingSnapshots.has(request)) return
        pending.sent = true
        if (states.size === keys.length) finish()
        else pending.timer = setTimeout(finish, 1000)
      }, () => finish(new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE')))
    })
  }

  async status(key: string): Promise<GatewayPresence> {
    const local = this.localPresence(key)
    if (local) return { online: true, lastSeenAt: new Date(local).toISOString() }
    const request = randomUUID()
    // Presence is queried only on an authorized device read. Idle sockets send
    // ping/pong in memory; they never write a row or query a database.
    return new Promise(resolve => {
      const finish = (seen = 0) => {
        if (!this.pendingPresence.delete(request)) return
        clearTimeout(timer)
        resolve(seen ? { online: true, lastSeenAt: new Date(seen).toISOString() } : OFFLINE)
      }
      const timer = setTimeout(finish, 1_000)
      this.pendingPresence.set(request, finish)
      void this.bus.publish({ type: 'probe', key, request }).catch(() => finish())
    })
  }

  async live(key: string, events: readonly LiveInvalidation[]) {
    const valid = liveInvalidations(events, true)
    if (!valid) return
    const message = { type: 'live', key, events: valid } as const
    this.receive(message)
    await this.bus.publish(message)
  }

  async revokeLive(key: string) {
    const message = { type: 'live_revoked', key } as const
    this.receive(message)
    await this.bus.publish(message)
  }

  async work(key: string) {
    const message = { type: 'work', key } as const
    this.receive(message)
    await this.bus.publish(message)
  }

  private receive(message: GatewayMessage, source?: string) {
    if (message.type === 'live_revoked') {
      clearTimeout(this.revokedLive.get(message.key))
      const expiry = setTimeout(() => this.revokedLive.delete(message.key), 300_000)
      expiry.unref?.()
      this.revokedLive.set(message.key, expiry)
      for (const [id, connection] of this.connections) {
        if (connection.socket.kind === 'live' && connection.socket.key === message.key) this.remove(id, 4001, 'live capability revoked')
      }
      return
    }
    if (message.type === 'session_revoked') {
      for (const [id, connection] of this.connections) {
        if (connection.socket.kind === 'live' && connection.socket.sessionId === message.sessionId) this.remove(id, 4001, 'session revoked')
      }
      return
    }
    if (message.type === 'inspect') {
      const devices = message.keys.flatMap(key => {
        const state = this.localSnapshot(key)
        return state ? [{ key, connection: state.connection, seen: state.seen, online: state.online }] : []
      })
      if (devices.length) void this.bus.publish({ type: 'snapshot', request: message.request, devices }).catch(() => this.disconnect())
      return
    }
    if (message.type === 'snapshot') {
      const pending = this.pendingSnapshots.get(message.request)
      if (!pending || !source) return
      for (const state of message.devices) if (pending.keys.has(state.key) && state.seen <= this.now() + 5000) {
        pending.states.set(state.key, { ...state, source, online: state.online && this.now() - state.seen < PRESENCE_ONLINE_MS })
      }
      if (pending.sent && pending.states.size === pending.keys.size) pending.finish()
      return
    }
    if (message.type === 'device_state') {
      if (source && message.seen <= this.now() + 5000) this.presence.changed({ ...message, source,
        online: message.online && this.now() - message.seen < PRESENCE_ONLINE_MS })
      return
    }
    if (message.type === 'claim' && source) {
      this.presence.changed({ key: message.key, connection: message.connection, source, seen: message.seen ?? this.now(), online: true }, true)
    }
    if (message.type === 'claim') {
      const opening = this.claims.get(message.connection)
      this.claims.delete(message.connection)
      // A peer may close after publishing but before its own ordered NOTIFY.
      // Terminate that exact claim after it is observed, so no remote watcher
      // can retain a ghost online device on this still-healthy source session.
      if (opening && this.connections.get(message.connection) !== opening) {
        opening.source = source; opening.online = false
        this.deviceChanged(opening)
      }
    }
    if (message.type === 'probe') {
      const seen = this.localPresence(message.key)
      if (seen) void this.bus.publish({ type: 'presence', request: message.request, seen }).catch(() => {})
      return
    }
    if (message.type === 'presence') {
      if (Number.isFinite(message.seen) && message.seen <= this.now() + 5_000 && this.now() - message.seen < PRESENCE_ONLINE_MS) {
        this.pendingPresence.get(message.request)?.(message.seen)
      }
      return
    }
    for (const connection of this.connections.values()) {
      const { peer, socket } = connection
      if (!connection.authorized) continue
      if (socket.key !== message.key) continue
      if (message.type === 'claim') {
        if (socket.kind !== 'device') continue
        if (peer.id === message.connection) {
          connection.claimed = true; connection.online = true; connection.source = source
          this.deviceDeadline(connection)
        }
        // Ignore claims committed before this socket's own claim. Postgres
        // delivers committed NOTIFYs in order, including this process's own,
        // so simultaneous reconnects converge without depending on clocks.
        else if (connection.claimed) this.remove(peer.id, 4000, 'replaced', false)
      } else if (message.type === 'work') {
        if (socket.kind === 'device') this.send(peer, 'work')
      } else if (socket.kind === 'live') {
        if (this.revokedLive.has(socket.key)) { this.remove(peer.id, 4001, 'live capability revoked'); continue }
        if (socket.expiresAt <= this.now()) { this.remove(peer.id, 4001, 'ticket expired'); continue }
        const events = socket.revisions ? message.events : withoutRevisions(message.events)
        for (const event of events) this.send(peer, JSON.stringify(event))
      }
    }
  }

  private send(peer: GatewayPeer, data: string) {
    try { peer.send(data) } catch { this.remove(peer.id, 1011, 'socket unavailable') }
  }

  disconnect() {
    this.presence.stop()
    this.claims.clear()
    // Losing the publishing session releases its PG lease. Never attempt to
    // reconnect that failed session just to send an untrustworthy offline edge.
    for (const id of this.connections.keys()) this.remove(id, 1012, 'gateway restarting', false)
    for (const finish of this.pendingPresence.values()) finish(0)
    for (const pending of this.pendingSnapshots.values()) pending.finish(new CodedError('BUILTIN_GATEWAY_PRESENCE_UNAVAILABLE'))
  }

  stop() {
    this.unsubscribe(); this.disconnect()
    for (const timer of this.revokedLive.values()) clearTimeout(timer)
    this.revokedLive.clear()
  }
}
