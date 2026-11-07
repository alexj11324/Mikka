import { randomUUID } from 'node:crypto'
import { liveInvalidations, liveReady, withoutRevisions, type LiveInvalidation } from '../live/events'

export type GatewayPeer = { id: string; send(data: string): unknown; close(code: number, reason: string): unknown }
export type GatewaySocket = { kind: 'live' | 'device'; key: string; expiresAt: number; revisions: boolean }
export type GatewayPresence = { online: boolean; lastSeenAt: string | null }
export type GatewayMessage =
  | { type: 'live'; key: string; events: LiveInvalidation[] }
  | { type: 'work'; key: string }
  | { type: 'claim'; key: string; connection: string }
  | { type: 'probe'; key: string; request: string }
  | { type: 'presence'; request: string; seen: number }

export interface GatewayBus {
  /** Claim messages are echoed to their publisher in the same commit order
   * seen by all replicas. Other messages exclude their publisher. */
  publish(message: GatewayMessage): Promise<void>
  subscribe(receive: (message: GatewayMessage) => void, lost: () => void): () => void
}
type Connection = { peer: GatewayPeer; socket: GatewaySocket; claimed: boolean; seen: number; expiry?: ReturnType<typeof setTimeout> }
const OFFLINE: GatewayPresence = { online: false, lastSeenAt: null }
const ONLINE_MS = 90_000

/** Holds sockets, never user content or database-backed heartbeats. Postgres
 * carries only the same invalidation keys and device wake signals as Workers. */
export class GatewayHub {
  private connections = new Map<string, Connection>()
  private pendingPresence = new Map<string, (seen: number) => void>()
  private unsubscribe: () => void

  constructor(private bus: GatewayBus, private now = Date.now) {
    this.unsubscribe = bus.subscribe(message => this.receive(message), () => this.disconnect())
  }

  async open(peer: GatewayPeer, socket: GatewaySocket) {
    const connection: Connection = { peer, socket, claimed: false, seen: this.now() }
    this.connections.set(peer.id, connection)
    if (socket.kind === 'live') {
      if (socket.expiresAt <= this.now()) { this.remove(peer.id, 4001, 'ticket expired'); return }
      connection.expiry = setTimeout(() => this.remove(peer.id, 4001, 'ticket expired'), socket.expiresAt - this.now())
      connection.expiry.unref?.()
      peer.send(JSON.stringify(liveReady(socket.revisions ? 2 : 1)))
    } else {
      const claim = { type: 'claim', key: socket.key, connection: peer.id } as const
      try { await this.bus.publish(claim) }
      catch { this.remove(peer.id, 1012, 'gateway unavailable') }
    }
  }

  message(peer: GatewayPeer, data: string) {
    const connection = this.connections.get(peer.id)
    if (!connection) return
    if (connection.socket.kind === 'live' && connection.socket.expiresAt <= this.now()) {
      this.remove(peer.id, 4001, 'ticket expired'); return
    }
    if (data === 'ping') { connection.seen = this.now(); peer.send('pong') }
  }

  close(peer: GatewayPeer) { this.remove(peer.id) }

  private remove(id: string, code?: number, reason = '') {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    clearTimeout(connection.expiry)
    if (code !== undefined) { try { connection.peer.close(code, reason) } catch { /* already closed */ } }
  }

  private localPresence(key: string): number {
    let seen = 0
    for (const connection of this.connections.values()) {
      if (connection.socket.kind === 'device' && connection.socket.key === key) seen = Math.max(seen, connection.seen)
    }
    return seen && this.now() - seen < ONLINE_MS ? seen : 0
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

  async work(key: string) {
    const message = { type: 'work', key } as const
    this.receive(message)
    await this.bus.publish(message)
  }

  private receive(message: GatewayMessage) {
    if (message.type === 'probe') {
      const seen = this.localPresence(message.key)
      if (seen) void this.bus.publish({ type: 'presence', request: message.request, seen }).catch(() => {})
      return
    }
    if (message.type === 'presence') {
      if (Number.isFinite(message.seen) && message.seen <= this.now() + 5_000 && this.now() - message.seen < ONLINE_MS) {
        this.pendingPresence.get(message.request)?.(message.seen)
      }
      return
    }
    for (const connection of this.connections.values()) {
      const { peer, socket } = connection
      if (socket.key !== message.key) continue
      if (message.type === 'claim') {
        if (socket.kind !== 'device') continue
        if (peer.id === message.connection) connection.claimed = true
        // Ignore claims committed before this socket's own claim. Postgres
        // delivers committed NOTIFYs in order, including this process's own,
        // so simultaneous reconnects converge without depending on clocks.
        else if (connection.claimed) this.remove(peer.id, 4000, 'replaced')
      } else if (message.type === 'work') {
        if (socket.kind === 'device') this.send(peer, 'work')
      } else if (socket.kind === 'live') {
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
    for (const id of this.connections.keys()) this.remove(id, 1012, 'gateway restarting')
    for (const finish of this.pendingPresence.values()) finish(0)
  }

  stop() { this.unsubscribe(); this.disconnect() }
}
