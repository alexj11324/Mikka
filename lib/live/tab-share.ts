/**
 * Tabs of one person share a live read. When a push lands, every open tab
 * re-reads the same SWR key at the same moment; here one tab reads and the
 * others take its result.
 *
 * The channel is named by the authenticated read-cache namespace and transport
 * scope. Every message names its key, so nothing crosses users, workspaces,
 * builds, roles or keys. The provider closes it on
 * sign-out or a user switch. A tab that hears no result in time reads itself.
 */
export type TabChannel = Pick<BroadcastChannel, 'postMessage' | 'close'> & { onmessage: ((event: MessageEvent) => void) | null }
type Message =
  | { type: 'claim'; key: string; id: string }
  | { type: 'release'; key: string; id: string }
  | { type: 'result'; key: string; id: string; data: unknown; age: number | null }
  | { type: 'failed'; key: string; id: string }

/** Long enough for every tab woken by the same push to post its claim. */
export const CLAIM_WINDOW_MS = 30
/** A claim without a result after this is abandoned: read yourself. */
export const RESULT_TIMEOUT_MS = 8_000
/** Only bridge delayed trailing refreshes; retained snapshots stay bounded. */
const MAX_SHARED_RESULTS = 32

export const tabShareChannelName = (namespace: string, scope: string | null) => `mikka-live-read:${JSON.stringify([namespace, scope])}`

type SharedResult = { data: unknown; age: number | null }
type Waiter = { resolve: (value: SharedResult | null) => void }
export type TabShareClock = { now(): number; later(callback: () => void, ms: number): unknown; cancel(timer: unknown): void }
const browserClock: TabShareClock = { now: () => performance.now(), later: (callback, ms) => setTimeout(callback, ms), cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }

export class TabShare {
  private channel: TabChannel | null
  /** Remote claims seen per key (id → when), until their result or failure. */
  private claims = new Map<string, Map<string, number>>()
  private waiters = new Map<string, Set<Waiter>>()
  private results = new Map<string, SharedResult & { at: number }>()
  /** Reads this tab took from another tab. */
  adopted = 0

  constructor(name: string, open: (name: string) => TabChannel | null = name => typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name), private clock: TabShareClock = browserClock) {
    this.channel = open(name)
    if (this.channel) this.channel.onmessage = event => this.received(event.data as Message)
  }

  close() { this.channel?.close(); this.channel = null; for (const set of this.waiters.values()) for (const waiter of set) waiter.resolve(null); this.waiters.clear(); this.claims.clear(); this.results.clear() }

  private received(message: Message) {
    if (!message || typeof message !== 'object' || typeof message.key !== 'string' || typeof message.id !== 'string') return
    if (message.type === 'claim') {
      let claims = this.claims.get(message.key)
      if (!claims) this.claims.set(message.key, claims = new Map())
      claims.set(message.id, this.clock.now())
      return
    }
    this.claims.get(message.key)?.delete(message.id)
    if (message.type === 'release') return
    if (message.type === 'result') this.remember(message.key, { data: message.data, age: message.age })
    const waiters = this.waiters.get(message.key)
    if (!waiters) return
    this.waiters.delete(message.key)
    for (const waiter of waiters) waiter.resolve(message.type === 'result' ? { data: message.data, age: message.age } : null)
  }

  private wait(key: string) {
    return new Promise<SharedResult | null>(resolve => {
      const waiter: Waiter = { resolve: value => { this.clock.cancel(timer); resolve(value) } }
      const timer = this.clock.later(() => { this.waiters.get(key)?.delete(waiter); resolve(null) }, RESULT_TIMEOUT_MS)
      let set = this.waiters.get(key)
      if (!set) this.waiters.set(key, set = new Set())
      set.add(waiter)
    })
  }

  private live(key: string) {
    const claims = this.claims.get(key)
    if (!claims) return []
    for (const [id, at] of claims) if (this.clock.now() - at > RESULT_TIMEOUT_MS) claims.delete(id)
    return [...claims.keys()]
  }

  private remember(key: string, value: SharedResult) {
    const now = this.clock.now()
    for (const [cachedKey, result] of this.results) if (now - result.at >= RESULT_TIMEOUT_MS) this.results.delete(cachedKey)
    this.results.delete(key)
    this.results.set(key, { ...value, at: now })
    if (this.results.size > MAX_SHARED_RESULTS) this.results.delete(this.results.keys().next().value!)
  }

  private recent(key: string): SharedResult | null {
    const value = this.results.get(key)
    if (!value) return null
    const elapsed = this.clock.now() - value.at
    if (elapsed >= RESULT_TIMEOUT_MS) { this.results.delete(key); return null }
    return { data: value.data, age: value.age === null ? null : value.age + elapsed }
  }

  /** Only accepted results may be adopted. Completed results also require explicit revision coverage; unversioned refreshes join only active reads. */
  async run<T>(key: string, read: () => Promise<T>, adopt: (data: T) => unknown, accepts?: (data: T) => boolean, reuseCompleted = false): Promise<unknown> {
    const channel = this.channel
    if (!channel) return read()
    const take = async (value: SharedResult | null): Promise<unknown> => {
      if (!value) return read()
      // A rejected old read does not consume this push. Rejoin arbitration so
      // its waiting tabs share one fresh read without depending on the old leader.
      if (accepts && !accepts(value.data as T)) return this.run(key, read, adopt, accepts, reuseCompleted)
      this.adopted++
      return adopt(rebased(value.data, value.age, this.clock.now()) as T)
    }
    if (reuseCompleted && accepts) {
      const result = this.recent(key)
      if (result && accepts(result.data as T)) return take(result)
    }
    // Another tab is already reading this key: take its result.
    if (this.live(key).length) return take(await this.wait(key))
    const id = `${this.clock.now().toFixed(3)}:${Math.random().toString(36).slice(2)}`
    channel.postMessage({ type: 'claim', key, id } satisfies Message)
    let answered = false
    const result = this.wait(key).then(value => { answered = value !== null; return value })
    await new Promise(resolve => this.clock.later(() => resolve(undefined), CLAIM_WINDOW_MS))
    // Woken by the same push: the lowest claim reads; a result that already arrived is taken.
    if (answered || this.live(key).some(other => other < id)) {
      // Losing candidates will not publish a result for their own claim.
      try { channel.postMessage({ type: 'release', key, id } satisfies Message) } catch { /* closing */ }
      return take(await result)
    }
    this.waiters.get(key)?.clear()
    try {
      const data = await read()
      const result = { data, age: age(data, this.clock.now()) }
      this.remember(key, result)
      try { channel.postMessage({ type: 'result', key, id, ...result } satisfies Message) }
      catch { channel.postMessage({ type: 'failed', key, id } satisfies Message) } // Not cloneable: the others read.
      return data
    } catch (error) {
      try { channel.postMessage({ type: 'failed', key, id } satisfies Message) } catch { /* closing */ }
      throw error
    }
  }
}

/** A read's `requestedAt` is the reading tab's own monotonic clock; carry its age instead. */
function age(data: unknown, now: number) {
  const at = (data as { requestedAt?: unknown } | null)?.requestedAt
  return typeof at === 'number' && Number.isFinite(at) ? Math.max(0, now - at) : null
}
function rebased(data: unknown, elapsed: number | null, now: number) {
  return elapsed !== null && data && typeof data === 'object' && !Array.isArray(data) ? { ...data, requestedAt: now - elapsed } : data
}
