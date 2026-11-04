import { liveInvalidation, LIVE_ID, type LiveKind } from './events'

export const LIVE_FALLBACK_MS = 60_000
const HEARTBEAT_MS = 30_000
type Timer = unknown
export type LiveTicket = { url: string; protocol: string; expiresAt: number }
export type LiveSocket = Pick<WebSocket, 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'readyState' | 'send' | 'close'>
export interface LiveRuntime {
  ticket(signal: AbortSignal): Promise<LiveTicket | null>
  socket(ticket: LiveTicket): LiveSocket
  visible(): boolean
  watchVisibility(changed: () => void): () => void
  now(): number
  later(callback: () => void, milliseconds: number): Timer
  cancel(timer: Timer): void
}
type Subscription = { kind: LiveKind; id: string; keys: readonly string[]; refresh: (key: string) => unknown }

/** One connection per mounted owner/workspace; repeated badges share each SWR read. */
export class LiveChannel {
  private subscriptions = new Set<Subscription>()
  private socket: LiveSocket | null = null
  private controller: AbortController | null = null
  private unwatch: (() => void) | null = null
  private generation = 0
  private connected = false
  private retryMs = 1_000
  private pong = true
  private timers = new Map<string, Timer>()
  private pending = new Map<string, Subscription['refresh']>()

  constructor(private runtime: LiveRuntime) {}

  subscribe(kind: LiveKind, id: string, keys: readonly string[], refresh: Subscription['refresh']) {
    if (!LIVE_ID.test(id)) return () => {}
    const subscription = { kind, id, keys, refresh }
    this.subscriptions.add(subscription)
    if (this.subscriptions.size === 1) {
      this.unwatch = this.runtime.watchVisibility(() => this.visibilityChanged())
      if (this.runtime.visible()) { this.fallback(); void this.connect() }
    }
    return () => {
      this.subscriptions.delete(subscription)
      if (!this.subscriptions.size) this.dispose()
    }
  }

  dispose() {
    this.generation++
    this.closeSocket()
    for (const timer of this.timers.values()) this.runtime.cancel(timer)
    this.timers.clear()
    this.pending.clear()
    this.unwatch?.()
    this.unwatch = null
    this.subscriptions.clear()
  }

  private clear(name: string) {
    if (this.timers.has(name)) this.runtime.cancel(this.timers.get(name))
    this.timers.delete(name)
  }

  private later(name: string, milliseconds: number, callback: () => void) {
    this.clear(name)
    this.timers.set(name, this.runtime.later(() => { this.timers.delete(name); callback() }, milliseconds))
  }

  private closeSocket() {
    this.connected = false
    this.controller?.abort()
    this.controller = null
    this.clear('heartbeat'); this.clear('renew')
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      try { socket.close() } catch { /* the connection may already be closed */ }
    }
  }

  private visibilityChanged() {
    if (!this.runtime.visible()) {
      this.generation++
      this.closeSocket()
      for (const timer of this.timers.values()) this.runtime.cancel(timer)
      this.timers.clear(); this.pending.clear()
    } else if (this.subscriptions.size) {
      this.invalidate()
      if (!this.connected && !this.controller) { this.fallback(); void this.connect() }
    }
  }

  private invalidate(kind?: LiveKind, id?: string) {
    if (!this.runtime.visible()) return
    for (const subscription of this.subscriptions) {
      if (kind && (subscription.kind !== kind || subscription.id !== id)) continue
      for (const key of subscription.keys) this.pending.set(key, subscription.refresh)
    }
    if (!this.pending.size || this.timers.has('flush')) return
    this.later('flush', 100, () => {
      const pending = this.pending
      this.pending = new Map()
      if (!this.runtime.visible()) return
      const activeKeys = new Set([...this.subscriptions].flatMap(value => [...value.keys]))
      for (const [key, refresh] of pending) {
        if (!activeKeys.has(key)) continue
        try { Promise.resolve(refresh(key)).catch(() => {}) } catch { /* SWR owns read errors */ }
      }
    })
  }

  private fallback() {
    if (this.connected || !this.runtime.visible() || !this.subscriptions.size || this.timers.has('fallback')) return
    this.later('fallback', LIVE_FALLBACK_MS, () => { this.invalidate(); this.fallback() })
  }

  private disconnected(generation: number, delay = this.retryMs) {
    if (generation !== this.generation) return
    this.generation++
    this.closeSocket()
    if (!this.runtime.visible() || !this.subscriptions.size) return
    this.fallback()
    this.later('retry', delay, () => { void this.connect() })
    this.retryMs = Math.min(this.retryMs * 2, LIVE_FALLBACK_MS)
  }

  private heartbeat(generation: number) {
    this.later('heartbeat', HEARTBEAT_MS, () => {
      if (generation !== this.generation || !this.connected) return
      if (!this.pong) { this.disconnected(generation); return }
      this.pong = false
      try { this.socket?.send('ping') } catch { this.disconnected(generation); return }
      this.heartbeat(generation)
    })
  }

  private async connect() {
    if (!this.runtime.visible() || !this.subscriptions.size || this.connected || this.controller) return
    this.clear('retry')
    const generation = ++this.generation
    const controller = this.controller = new AbortController()
    try {
      const ticket = await this.runtime.ticket(controller.signal)
      if (generation !== this.generation || !this.runtime.visible()) return
      if (!ticket || ticket.expiresAt <= this.runtime.now()) { this.disconnected(generation, LIVE_FALLBACK_MS); return }
      const socket = this.socket = this.runtime.socket(ticket)
      socket.onopen = () => {
        if (generation !== this.generation) return
        this.connected = true; this.retryMs = 1_000; this.pong = true
        this.clear('fallback')
        this.invalidate() // Covers changes committed while the connection was opening.
        this.heartbeat(generation)
        this.later('renew', Math.max(1, ticket.expiresAt - this.runtime.now()), () => this.disconnected(generation, 0))
      }
      socket.onmessage = message => {
        if (generation !== this.generation || !this.runtime.visible()) return
        if (message.data === 'pong') { this.pong = true; return }
        if (typeof message.data !== 'string' || message.data.length > 256) return
        try { const value = liveInvalidation(JSON.parse(message.data)); if (value) this.invalidate(value.kind, value.id) } catch { /* malformed keys cannot trigger reads */ }
      }
      socket.onclose = socket.onerror = () => this.disconnected(generation)
      // Bound a connection that never reaches open/close, including a dead proxy.
      this.later('renew', 15_000, () => { if (!this.connected) this.disconnected(generation) })
    } catch {
      this.disconnected(generation)
    }
  }
}
