import { liveCapabilities, liveInvalidation, LIVE_ID, type LiveKind } from './events'

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
  /** Browser clock adjustments cannot postpone relative read/deadline timers. */
  monotonicNow?(): number
  later(callback: () => void, milliseconds: number): Timer
  cancel(timer: Timer): void
}
export type LiveSubscriptionOptions = {
  /** Minimum spacing for changes, never for reconnect/visibility catch-up. */ minIntervalMs?: number
  /** One read at a server-derived deadline. A real HTTP read may identify its
   * observation only while the server still reports a future deadline. */ deadline?: { at: string; afterMs: number; observation?: number } | null
}
export type LiveSubscription = (() => void) & { update(options: LiveSubscriptionOptions): void }
type Subscription = { kind: LiveKind; id: string; keys: readonly string[]; refresh: (key: string) => unknown; minIntervalMs: number; deadlineAt: number | null; deadlineKey: string | null; deadlineObservation: number | null; timer: string }
type PendingRead = { refresh: Subscription['refresh']; at: number }

/** One connection per mounted owner/workspace; repeated badges share each SWR read. */
export class LiveChannel {
  private subscriptions = new Set<Subscription>()
  private socket: LiveSocket | null = null
  private controller: AbortController | null = null
  private unwatch: (() => void) | null = null
  private generation = 0
  private connected = false
  private capabilities = new Set<LiveKind>()
  private retryMs = 1_000
  private pong = true
  private timers = new Map<string, Timer>()
  private pending = new Map<string, PendingRead>()
  private lastRead = new Map<string, number>()
  private inFlight = new Map<string, symbol>()
  private flushAt: number | null = null
  private nextDeadline = 0

  constructor(private runtime: LiveRuntime) {}

  subscribe(kind: LiveKind, id: string, keys: readonly string[], refresh: Subscription['refresh'], options: LiveSubscriptionOptions = {}): LiveSubscription {
    if (!LIVE_ID.test(id)) return Object.assign(() => {}, { update() {} })
    const subscription: Subscription = { kind, id, keys, refresh, minIntervalMs: Math.max(0, options.minIntervalMs ?? 0),
      deadlineAt: options.deadline && Number.isFinite(options.deadline.afterMs) ? this.localNow() + Math.max(0, options.deadline.afterMs) : null,
      deadlineKey: options.deadline?.at ?? null,
      deadlineObservation: Number.isFinite(options.deadline?.observation) ? options.deadline!.observation! : null,
      timer: `deadline:${++this.nextDeadline}` }
    this.subscriptions.add(subscription)
    if (this.subscriptions.size === 1) {
      this.unwatch = this.runtime.watchVisibility(() => this.visibilityChanged())
      if (this.runtime.visible()) { this.fallback(); void this.connect() }
    }
    if (this.connected && this.runtime.visible()) this.invalidate(kind, id, true)
    this.fallback()
    this.scheduleDeadline(subscription)
    const stop = () => {
      this.subscriptions.delete(subscription)
      this.clear(subscription.timer)
      if (this.allSupported()) this.clear('fallback')
      if (!this.subscriptions.size) this.dispose()
      else for (const key of keys) {
        if ([...this.subscriptions].some(value => value.keys.includes(key))) continue
        this.pending.delete(key); this.lastRead.delete(key); this.inFlight.delete(key)
      }
    }
    return Object.assign(stop, { update: (next: LiveSubscriptionOptions) => {
      if (!this.subscriptions.has(subscription)) return
      subscription.minIntervalMs = Math.max(0, next.minIntervalMs ?? 0)
      const key = next.deadline?.at ?? null
      const observation = Number.isFinite(next.deadline?.observation) ? next.deadline!.observation! : null
      if (key === subscription.deadlineKey) {
        const fresh = observation !== null && (subscription.deadlineObservation === null || observation > subscription.deadlineObservation)
        if (fresh) subscription.deadlineObservation = observation
        // Never postpone an active conservative timer. After it has fired, only
        // a newer actual server-future read can arrange the still-needed check.
        if (subscription.deadlineAt !== null || !fresh) return
      } else subscription.deadlineObservation = observation
      subscription.deadlineKey = key
      subscription.deadlineAt = next.deadline && Number.isFinite(next.deadline.afterMs)
        ? this.localNow() + Math.max(0, next.deadline.afterMs) : null
      this.clear(subscription.timer)
      this.scheduleDeadline(subscription)
    } })
  }

  dispose() {
    this.generation++
    this.closeSocket()
    for (const timer of this.timers.values()) this.runtime.cancel(timer)
    this.timers.clear()
    this.pending.clear()
    this.lastRead.clear(); this.inFlight.clear(); this.flushAt = null
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
    this.capabilities.clear()
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
      this.timers.clear(); this.pending.clear(); this.inFlight.clear(); this.flushAt = null
    } else if (this.subscriptions.size) {
      this.invalidate()
      for (const subscription of this.subscriptions) {
        if (subscription.deadlineAt !== null && subscription.deadlineAt <= this.localNow()) subscription.deadlineAt = null
        this.scheduleDeadline(subscription)
      }
      if (!this.connected && !this.controller) { this.fallback(); void this.connect() }
    }
  }

  private localNow() { return this.runtime.monotonicNow?.() ?? this.runtime.now() }

  private scheduleDeadline(subscription: Subscription) {
    if (!this.runtime.visible() || subscription.deadlineAt === null) return
    this.later(subscription.timer, Math.min(2_147_483_647, Math.max(0, subscription.deadlineAt - this.localNow())), () => {
      if (!this.subscriptions.has(subscription) || subscription.deadlineAt === null) return
      if (subscription.deadlineAt > this.localNow()) { this.scheduleDeadline(subscription); return }
      subscription.deadlineAt = null
      this.invalidate(subscription.kind, subscription.id, true)
    })
  }

  private invalidate(kind?: LiveKind, id?: string, immediate = false, unsupportedOnly = false) {
    if (!this.runtime.visible()) return
    for (const subscription of this.subscriptions) {
      if (kind && (subscription.kind !== kind || subscription.id !== id)) continue
      if (unsupportedOnly && this.connected && this.capabilities.has(subscription.kind)) continue
      for (const key of subscription.keys) {
        const at = kind && !immediate ? Math.max(this.localNow(), (this.lastRead.get(key) ?? -Infinity) + subscription.minIntervalMs) : this.localNow()
        const previous = this.pending.get(key)
        this.pending.set(key, { refresh: subscription.refresh, at: Math.min(at, previous?.at ?? Infinity) })
      }
    }
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (!this.runtime.visible()) return
    const ready = [...this.pending].filter(([key]) => !this.inFlight.has(key))
    if (!ready.length) return
    const at = Math.max(this.localNow() + 100, Math.min(...ready.map(([, value]) => value.at)))
    if (this.flushAt !== null && this.flushAt <= at) return
    this.later('flush', at - this.localNow(), () => { this.flushAt = null; this.flush() })
    this.flushAt = at
  }

  private flush() {
    if (!this.runtime.visible()) return
    const activeKeys = new Set([...this.subscriptions].flatMap(value => [...value.keys]))
    for (const [key, { refresh, at }] of this.pending) {
      if (!activeKeys.has(key)) { this.pending.delete(key); continue }
      if (this.inFlight.has(key) || at > this.localNow()) continue
      this.pending.delete(key)
      this.lastRead.set(key, this.localNow())
      const request = Symbol()
      this.inFlight.set(key, request)
      const settled = () => {
        if (this.inFlight.get(key) !== request) return
        this.inFlight.delete(key)
        // A notification during a read is still dirty: deliver one trailing read.
        this.scheduleFlush()
      }
      try { Promise.resolve(refresh(key)).catch(() => {}).finally(settled) }
      catch { settled() } // SWR owns read errors.
    }
    this.scheduleFlush()
  }

  private allSupported() {
    return this.connected && [...this.subscriptions].every(subscription => this.capabilities.has(subscription.kind))
  }

  private fallback() {
    if (this.allSupported() || !this.runtime.visible() || !this.subscriptions.size || this.timers.has('fallback')) return
    this.later('fallback', LIVE_FALLBACK_MS, () => { this.invalidate(undefined, undefined, false, true); this.fallback() })
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
        // An open socket/pong is not evidence that this Worker supports a new kind.
        this.fallback()
        this.invalidate() // Covers changes committed while the connection was opening.
        this.heartbeat(generation)
        this.later('renew', Math.max(1, ticket.expiresAt - this.runtime.now()), () => this.disconnected(generation, 0))
      }
      socket.onmessage = message => {
        if (generation !== this.generation || !this.runtime.visible()) return
        if (message.data === 'pong') { this.pong = true; return }
        if (typeof message.data !== 'string' || message.data.length > 2_048) return
        try {
          const parsed: unknown = JSON.parse(message.data)
          const capabilities = liveCapabilities(parsed)
          if (capabilities) {
            this.capabilities = new Set(capabilities)
            if (this.allSupported()) this.clear('fallback'); else this.fallback()
            return
          }
          if (message.data.length > 256) return
          const value = liveInvalidation(parsed)
          if (value) this.invalidate(value.kind, value.id)
        } catch { /* malformed keys/capabilities cannot trigger reads or disable fallback */ }
      }
      socket.onclose = socket.onerror = () => this.disconnected(generation)
      // Bound a connection that never reaches open/close, including a dead proxy.
      this.later('renew', 15_000, () => { if (!this.connected) this.disconnected(generation) })
    } catch {
      this.disconnected(generation)
    }
  }
}
