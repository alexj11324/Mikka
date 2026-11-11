import { liveInvalidation, liveReadiness, LIVE_ID, LIVE_REVISION_PARAM, type LiveKind } from './events'
import { liveRevisionKey, type LiveRevisions } from './revisions'
import { LIVE_PRESENCE_PARAM, PRESENCE_MAX_TOKEN_BYTES, PRESENCE_MAX_WATCHES_PER_SOCKET, presenceReply, type PresenceCommand, type PresenceProof } from './presence'
import { readBoundary } from '../swr/read-observer'

export const LIVE_FALLBACK_MS = 60_000
const HEARTBEAT_MS = 30_000
type Timer = unknown
export type LiveTicket = { url: string; protocol: string; expiresAt: number }
export type LiveSocket = Pick<WebSocket, 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'readyState' | 'send' | 'close'>
export type LiveObservation = { event: 'socket' | 'received' | 'skipped' | 'read'; state?: 'connecting' | 'open' | 'ready' | 'closed'; reason?: 'hidden' | 'revision_held' | 'unsubscribed' | 'covered' | 'invalid'; kind?: LiveKind; id?: string; rev?: number; key?: string
  /** Round trip of the heartbeat that just answered, in milliseconds. Present only on
   * `received`/`socket` observations that close a ping, and absent when the runtime
   * cannot supply a monotonic clock. A browser clock adjustment cannot make it
   * negative the way `Date.now()` arithmetic can. */
  rttMs?: number }
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
  /** A device-dependent read keeps fallback until this exact watch is acknowledged.
   * Null means required but unavailable; absent means no presence dependency. */ presence?: PresenceProof | null
}
export type LiveSubscription = (() => void) & { update(options: LiveSubscriptionOptions): void }
/** Shared reads cover every known revision; only fully versioned pushes may reuse a completed result. */
export type LiveRefresh = (key: string, requiredRevisions?: Readonly<LiveRevisions>, reuseCompleted?: boolean, after?: number) => unknown
type Subscription = { kind: LiveKind; id: string; keys: readonly string[]; refresh: LiveRefresh; minIntervalMs: number; deadlineAt: number | null; deadlineKey: string | null; deadlineObservation: number | null; timer: string; revisions: Map<string, number>; presence: PresenceProof | null | undefined }
type PresenceWatch = { id: string; proof: PresenceProof; coveredUntil: number | null; unavailable: boolean }
/** An unversioned event always reads, while retaining any known revisions merged into that read. */
type PendingRead = { at: number; after: number; unconditional: boolean; waits: { subscription: Subscription; key: string; rev: number }[] }
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
  /** Continuous coverage starts at this generation's capability acknowledgement.
   * Pushes advance only their bounded event kind, including unsubscribed keys. */
  private coverageAfter: number | null = null
  private invalidationAfter = new Map<LiveKind, number>()
  private capabilities = new Set<LiveKind>()
  private revisionKinds = new Set<LiveKind>()
  private presenceSupported = false
  private presenceWatches = new Map<string, PresenceWatch>()
  private nextPresence = 0
  /** Reads a push did not need because the key's data already held its revision. */
  skippedReads = 0
  private retryMs = 1_000
  private pong = true
  /** Monotonic time the outstanding `ping` was sent at, null when none is in flight. */
  private pingSentAt: number | null = null
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
    return this.connected && subscriptions.every(subscription => this.supported(subscription))
  }

  subscribe(kind: LiveKind, id: string, keys: readonly string[], refresh: Subscription['refresh'], options: LiveSubscriptionOptions = {}): LiveSubscription {
    if (!LIVE_ID.test(id)) return Object.assign(() => {}, { update() {} })
    const subscription: Subscription = { kind, id, keys, refresh, minIntervalMs: Math.max(0, options.minIntervalMs ?? 0),
      deadlineAt: options.deadline && Number.isFinite(options.deadline.afterMs) ? this.localNow() + Math.max(0, options.deadline.afterMs) : null,
      deadlineKey: options.deadline?.at ?? null,
      deadlineObservation: Number.isFinite(options.deadline?.observation) ? options.deadline!.observation! : null,
      timer: `deadline:${++this.nextDeadline}`, revisions: heldRevisions(options.revisions), presence: options.presence }
    this.subscriptions.add(subscription)
    if (this.subscriptions.size === 1) {
      this.unwatch = this.runtime.watchVisibility(() => this.visibilityChanged())
      if (this.runtime.visible()) { this.fallback(); void this.connect() }
    }
    if (this.connected && this.runtime.visible()) this.invalidate(kind, id, true, false, undefined,
      this.supported(subscription) && this.coverageAfter !== null
        ? Math.max(this.coverageAfter, this.invalidationAfter.get(kind) ?? 0) : undefined)
    this.syncPresence()
    this.fallback()
    this.scheduleDeadline(subscription)
    const stop = () => {
      this.subscriptions.delete(subscription)
      this.clear(subscription.timer)
      this.syncPresence()
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
      subscription.presence = next.presence
      this.syncPresence()
      if (this.allSupported()) this.clear('fallback'); else this.fallback()
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
    this.coverageAfter = null
    this.invalidationAfter.clear()
    this.capabilities.clear(); this.revisionKinds.clear()
    this.presenceSupported = false
    for (const watch of this.presenceWatches.values()) this.clear(`presence:${watch.id}`)
    this.presenceWatches.clear()
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

  private invalidate(kind?: LiveKind, id?: string, immediate = false, unsupportedOnly = false, rev?: number, after = readBoundary()) {
    if (!this.runtime.visible()) { this.observe({ event: 'skipped', reason: 'hidden', kind, id, rev }); return }
    for (const subscription of this.subscriptions) {
      if (kind && (subscription.kind !== kind || subscription.id !== id)) continue
      if (unsupportedOnly && this.connected && this.supported(subscription)) continue
      for (const key of subscription.keys) {
        // A duplicate push, or the echo of this tab's own write, is already shown.
        if (rev !== undefined && (subscription.revisions.get(key) ?? 0) >= rev) { this.skippedReads++; this.observe({ event: 'skipped', reason: 'revision_held', kind: subscription.kind, id: subscription.id, rev, key }); continue }
        const at = kind && !immediate ? Math.max(this.localNow(), (this.lastRead.get(key) ?? -Infinity) + subscription.minIntervalMs) : this.localNow()
        const previous = this.pending.get(key)
        const waits = [...previous?.waits ?? [], ...rev === undefined ? [] : [{ subscription, key, rev }]]
        this.pending.set(key, { at: Math.min(at, previous?.at ?? Infinity), after: Math.max(after, previous?.after ?? after),
          unconditional: rev === undefined || previous?.unconditional === true, waits })
      }
    }
    this.scheduleFlush()
  }

  /** Every push behind this read is covered by data that arrived meanwhile. */
  private covered(read: PendingRead) {
    return !read.unconditional && read.waits.every(({ subscription, key, rev }) => (subscription.revisions.get(key) ?? 0) >= rev)
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
    for (const [key, read] of this.pending) {
      const { at } = read
      // A key can outlive one of its consumers (e.g. the native badge and its
      // Board). Never let a departed consumer's refresh discard the obligation.
      const entity = [...this.subscriptions].find(subscription => subscription.keys.includes(key))
      if (!entity) { this.pending.delete(key); this.observe({ event: 'skipped', reason: 'unsubscribed', key }); continue }
      if (this.covered(read)) { this.pending.delete(key); this.skippedReads++; this.observe({ event: 'skipped', reason: 'covered', key }); continue }
      if (this.inFlight.has(key) || at > this.localNow()) continue
      this.pending.delete(key)
      this.lastRead.set(key, this.localNow())
      const request = Symbol()
      this.inFlight.set(key, request)
      this.observe({ event: 'read', key, kind: entity.kind, id: entity.id })
      const settled = () => {
        if (this.inFlight.get(key) !== request) return
        this.inFlight.delete(key)
        // A notification during a read is still dirty: deliver one trailing read.
        this.scheduleFlush()
      }
      // A completed SWR read can precede this flush. Preserve every active
      // consumer's higher revision even if that read replaced the cache first.
      const held = [...this.subscriptions].flatMap(subscription => {
        const rev = subscription.revisions.get(key)
        return subscription.keys.includes(key) && rev !== undefined ? [{ subscription, rev }] : []
      })
      const requirements = [...read.waits, ...held]
      const required = requirements.length ? requirements.reduce<LiveRevisions>((revisions, { subscription, rev }) => {
        const ref = liveRevisionKey(subscription.kind, subscription.id.toLowerCase())
        revisions[ref] = Math.max(revisions[ref] ?? 0, rev)
        return revisions
      }, {}) : undefined
      try { Promise.resolve(entity.refresh(key, required, !read.unconditional, read.after)).catch(() => {}).finally(settled) }
      catch { settled() } // SWR owns read errors.
    }
    this.scheduleFlush()
  }

  private allSupported() {
    return this.connected && [...this.subscriptions].every(subscription => this.supported(subscription))
  }

  private supported(subscription: Subscription) {
    if (!this.capabilities.has(subscription.kind)) return false
    if (subscription.presence === undefined) return true
    const watch = subscription.presence && this.presenceWatches.get(subscription.presence.token)
    return this.presenceSupported && !!watch && !watch.unavailable && watch.coveredUntil !== null && watch.coveredUntil > this.localNow()
  }

  private sendPresence(command: PresenceCommand) {
    if (!this.socket || !this.connected) return false
    try { this.socket.send(JSON.stringify(command)); return true }
    catch { this.disconnected(this.generation); return false }
  }

  /** The real mounted subscriptions own these watches. Equal proofs share one
   * registration; changing data does not force a read or a ticket renewal. */
  private syncPresence() {
    if (!this.connected || !this.presenceSupported || !this.runtime.visible()) return
    const wanted = new Map<string, PresenceProof>()
    for (const { presence } of this.subscriptions) {
      if (!presence || typeof presence.token !== 'string' || presence.token.length > PRESENCE_MAX_TOKEN_BYTES
        || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(presence.token) || !Number.isSafeInteger(presence.expiresAt) || presence.expiresAt <= this.runtime.now()) continue
      wanted.set(presence.token, presence)
    }
    for (const [token, watch] of this.presenceWatches) if (!wanted.has(token)) {
      this.presenceWatches.delete(token)
      this.clear(`presence:${watch.id}`)
      if (!this.sendPresence({ type: 'presence_unwatch', id: watch.id })) return
    }
    for (const [token, proof] of wanted) {
      if (this.presenceWatches.has(token) || this.presenceWatches.size >= PRESENCE_MAX_WATCHES_PER_SOCKET) continue
      const watch: PresenceWatch = { id: `p${++this.nextPresence}`, proof, coveredUntil: null, unavailable: false }
      this.presenceWatches.set(token, watch)
      // Expiry only marks this watch uncovered. The existing fallback and
      // ticket lifecycle own future reads; no new renewal/read timer is added.
      this.expirePresence(watch, proof.expiresAt)
      if (!this.sendPresence({ type: 'presence_watch', id: watch.id, token })) return
    }
  }

  private expirePresence(watch: PresenceWatch, expiresAt: number) {
    this.later(`presence:${watch.id}`, Math.max(0, expiresAt - this.runtime.now()), () => {
      if (this.presenceWatches.get(watch.proof.token) !== watch) return
      watch.coveredUntil = null; watch.unavailable = true
      this.sendPresence({ type: 'presence_unwatch', id: watch.id })
      this.fallback()
    })
  }

  private receivePresence(value: unknown) {
    const reply = presenceReply(value)
    if (!reply) return false
    if (reply.type === 'presence_ready') {
      this.presenceSupported = true
      this.syncPresence()
    } else {
      const watch = [...this.presenceWatches.values()].find(item => item.id === reply.id)
      if (!this.presenceSupported || !watch) return true
      if (reply.type === 'presence_unavailable') {
        watch.coveredUntil = null; watch.unavailable = true
        this.clear(`presence:${watch.id}`)
      } else if (!watch.unavailable && reply.expiresAt > this.runtime.now() && reply.expiresAt <= watch.proof.expiresAt) {
        watch.coveredUntil = this.localNow() + reply.expiresAt - this.runtime.now()
        this.coverageAfter = readBoundary()
        this.expirePresence(watch, reply.expiresAt)
      }
    }
    if (this.allSupported()) this.clear('fallback'); else this.fallback()
    return true
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
      // Record when the ping left, on the same clock the reply is timed with.
      // Null when the runtime has no monotonic clock: then no rttMs is reported
      // rather than measuring across a clock that can jump.
      this.pingSentAt = this.runtime.monotonicNow?.() ?? null
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
      url.searchParams.set(LIVE_PRESENCE_PARAM, '1')
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
        if (message.data === 'pong') {
          this.pong = true
          // Report the round trip this pong closes. Read-only: `pong`, the
          // heartbeat cadence and every reconnect decision stay as they were.
          const sentAt = this.pingSentAt
          this.pingSentAt = null
          const now = this.runtime.monotonicNow?.()
          // A runtime without a monotonic clock reports no figure instead of
          // measuring across a clock that can jump.
          if (sentAt !== null && now !== undefined) this.observe({ event: 'received', rttMs: Math.max(0, Math.round(now - sentAt)) })
          return
        }
        if (typeof message.data !== 'string' || message.data.length > 2_048) return
        try {
          const parsed: unknown = JSON.parse(message.data)
          if (this.receivePresence(parsed)) return
          const readiness = liveReadiness(parsed)
          if (readiness) {
            this.observe({ event: 'socket', state: 'ready' })
            this.coverageAfter = readBoundary()
            this.capabilities = new Set(readiness.kinds)
            this.revisionKinds = new Set(readiness.revisions)
            if (this.allSupported()) this.clear('fallback'); else this.fallback()
            return
          }
          if (message.data.length > 256) return
          const value = liveInvalidation(parsed, this.revisionKinds.size > 0)
          if (value) {
            this.observe({ event: 'received', kind: value.kind, id: value.id, rev: value.rev })
            const after = readBoundary()
            this.invalidationAfter.set(value.kind, after)
            this.invalidate(value.kind, value.id, false, false, value.rev !== undefined && this.revisionKinds.has(value.kind) ? value.rev : undefined, after)
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
