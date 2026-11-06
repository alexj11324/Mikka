import { liveInvalidation, liveReadiness, LIVE_ID, LIVE_REVISION_PARAM, type LiveKind } from './events'

export const LIVE_FALLBACK_MS = 60_000
const HEARTBEAT_MS = 30_000
type Timer = unknown
export type LiveTicket = { url: string; protocol: string; expiresAt: number }
export type LiveSocket = Pick<WebSocket, 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'readyState' | 'send' | 'close'>
export type LiveObservation = { event: 'socket' | 'received' | 'skipped' | 'read'; state?: 'connecting' | 'open' | 'ready' | 'closed'; reason?: 'hidden' | 'revision_held' | 'unsubscribed' | 'covered' | 'invalid'; kind?: LiveKind; id?: string; rev?: number; key?: string }
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
  /** Optional metadata-only observer. It must never change transport behavior. */
  observe?(observation: LiveObservation): void
}
export type LiveSubscriptionOptions = {
  /** Minimum spacing for changes, never for reconnect/visibility catch-up. */ minIntervalMs?: number
  /** One read at a server-derived deadline. A real HTTP read may identify its
   * observation only while the server still reports a future deadline. */ deadline?: { at: string; afterMs: number; observation?: number } | null
  /** Per SWR key: this entity's revision its current data was read at (read
   * before the data, lib/live/revisions.ts). A push at or below it skips that
   * key's read; a missing or unknown revision always reads. */ revisions?: Readonly<Record<string, number | null | undefined>> | null
}
export type LiveSubscription = (() => void) & { update(options: LiveSubscriptionOptions): void }
type Subscription = { kind: LiveKind; id: string; keys: readonly string[]; refresh: (key: string) => unknown; minIntervalMs: number; deadlineAt: number | null; deadlineKey: string | null; deadlineObservation: number | null; timer: string; revisions: Map<string, number> }
/** `waits: null` reads unconditionally; otherwise the read is skipped once every listed revision is held. */
type PendingRead = { refresh: Subscription['refresh']; at: number; waits: { subscription: Subscription; key: string; rev: number }[] | null }
const heldRevisions = (value: LiveSubscriptionOptions['revisions']) => new Map(Object.entries(value ?? {})
  .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isSafeInteger(entry[1]) && entry[1] > 0))

/** One connection per mounted owner/workspace; repeated badges share each SWR read. */
export class LiveChannel {
  private subscriptions = new Set<Subscription>()
  private socket: LiveSocket | null = null
  private controller: AbortController | null = null
  private unwatch: (() => void) | null = null
  private generation = 0
  private connected = false
  private capabilities = new Set<LiveKind>()
  private revisionKinds = new Set<LiveKind>()
  /** Reads a push did not need because the key's data already held its revision. */
  skippedReads = 0
  private retryMs = 1_000
  private pong = true
  private timers = new Map<string, Timer>()
  private pending = new Map<string, PendingRead>()
  private lastRead = new Map<string, number>()
  private inFlight = new Map<string, symbol>()
  private flushAt: number | null = null
  private nextDeadline = 0

  constructor(private runtime: LiveRuntime) {}

  private observe(observation: LiveObservation) {
    try { this.runtime.observe?.(observation) } catch { /* analytics never changes a read */ }
  }

  keyConnected(key: string): boolean | undefined {
    const subscriptions = [...this.subscriptions].filter(subscription => subscription.keys.includes(key))
    if (!subscriptions.length) return undefined
    return this.connected && subscriptions.every(subscription => this.capabilities.has(subscription.kind))
  }

  subscribe(kind: LiveKind, id: string, keys: readonly string[], refresh: Subscription['refresh'], options: LiveSubscriptionOptions = {}): LiveSubscription {
    if (!LIVE_ID.test(id)) return Object.assign(() => {}, { update() {} })
    const subscription: Subscription = { kind, id, keys, refresh, minIntervalMs: Math.max(0, options.minIntervalMs ?? 0),
      deadlineAt: options.deadline && Number.isFinite(options.deadline.afterMs) ? this.localNow() + Math.max(0, options.deadline.afterMs) : null,
      deadlineKey: options.deadline?.at ?? null,
      deadlineObservation: Number.isFinite(options.deadline?.observation) ? options.deadline!.observation! : null,
      timer: `deadline:${++this.nextDeadline}`, revisions: heldRevisions(options.revisions) }
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
      // A revision only moves forward: an older response cannot reopen a covered push.
      for (const [key, rev] of heldRevisions(next.revisions)) if (rev > (subscription.revisions.get(key) ?? 0)) subscription.revisions.set(key, rev)
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
    this.capabilities.clear(); this.revisionKinds.clear()
    this.controller?.abort()
    this.controller = null
    this.clear('heartbeat'); this.clear('renew')
    const socket = this.socket
    this.socket = null
    if (socket) {
      this.observe({ event: 'socket', state: 'closed' })
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
      // A real hidden/offline interval has closed the socket and always reads.
      // Duplicate visible/online events on a healthy channel leave supported
      // keys to SWR's age-based focus check; unsupported kinds still catch up.
      this.invalidate(undefined, undefined, false, true)
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

  private invalidate(kind?: LiveKind, id?: string, immediate = false, unsupportedOnly = false, rev?: number) {
    if (!this.runtime.visible()) { this.observe({ event: 'skipped', reason: 'hidden', kind, id, rev }); return }
    for (const subscription of this.subscriptions) {
      if (kind && (subscription.kind !== kind || subscription.id !== id)) continue
      if (unsupportedOnly && this.connected && this.capabilities.has(subscription.kind)) continue
      for (const key of subscription.keys) {
        // A duplicate push, or the echo of this tab's own write, is already shown.
        if (rev !== undefined && (subscription.revisions.get(key) ?? 0) >= rev) { this.skippedReads++; this.observe({ event: 'skipped', reason: 'revision_held', kind: subscription.kind, id: subscription.id, rev, key }); continue }
        const at = kind && !immediate ? Math.max(this.localNow(), (this.lastRead.get(key) ?? -Infinity) + subscription.minIntervalMs) : this.localNow()
        const previous = this.pending.get(key)
        const wait = rev === undefined ? null : [{ subscription, key, rev }]
        const waits = !wait || (previous && !previous.waits) ? null : [...previous?.waits ?? [], ...wait]
        this.pending.set(key, { refresh: subscription.refresh, at: Math.min(at, previous?.at ?? Infinity), waits })
      }
    }
    this.scheduleFlush()
  }

  /** Every push behind this read is covered by data that arrived meanwhile. */
  private covered(read: PendingRead) {
    return read.waits !== null && read.waits.every(({ subscription, key, rev }) => (subscription.revisions.get(key) ?? 0) >= rev)
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
    for (const [key, read] of this.pending) {
      const { refresh, at } = read
      if (!activeKeys.has(key)) { this.pending.delete(key); this.observe({ event: 'skipped', reason: 'unsubscribed', key }); continue }
      if (this.covered(read)) { this.pending.delete(key); this.skippedReads++; this.observe({ event: 'skipped', reason: 'covered', key }); continue }
      if (this.inFlight.has(key) || at > this.localNow()) continue
      this.pending.delete(key)
      this.lastRead.set(key, this.localNow())
      const request = Symbol()
      this.inFlight.set(key, request)
      const entity = [...this.subscriptions].find(subscription => subscription.keys.includes(key))
      this.observe({ event: 'read', key, kind: entity?.kind, id: entity?.id })
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
    this.observe({ event: 'socket', state: 'connecting' })
    try {
      const ticket = await this.runtime.ticket(controller.signal)
      if (generation !== this.generation || !this.runtime.visible()) return
      if (!ticket || ticket.expiresAt <= this.runtime.now()) { this.disconnected(generation, LIVE_FALLBACK_MS); return }
      // Ask for revisions. An older Worker ignores the parameter and answers version 1.
      const url = new URL(ticket.url)
      url.searchParams.set(LIVE_REVISION_PARAM, '1')
      const socket = this.socket = this.runtime.socket({ ...ticket, url: url.href })
      socket.onopen = () => {
        if (generation !== this.generation) return
        this.connected = true; this.retryMs = 1_000; this.pong = true
        this.observe({ event: 'socket', state: 'open' })
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
          const readiness = liveReadiness(parsed)
          if (readiness) {
            this.observe({ event: 'socket', state: 'ready' })
            this.capabilities = new Set(readiness.kinds)
            this.revisionKinds = new Set(readiness.revisions)
            if (this.allSupported()) this.clear('fallback'); else this.fallback()
            return
          }
          if (message.data.length > 256) return
          const value = liveInvalidation(parsed, this.revisionKinds.size > 0)
          if (value) {
            this.observe({ event: 'received', kind: value.kind, id: value.id, rev: value.rev })
            this.invalidate(value.kind, value.id, false, false, value.rev !== undefined && this.revisionKinds.has(value.kind) ? value.rev : undefined)
          } else this.observe({ event: 'skipped', reason: 'invalid' })
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
