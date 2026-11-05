/**
 * Tabs of one person share a live read. When a push lands, every open tab
 * re-reads the same SWR key at the same moment; here one tab reads and the
 * others take its result.
 *
 * The channel is named by user and workspace scope and every message names its
 * key, so nothing crosses users, workspaces or keys. The provider closes it on
 * sign-out or a user switch. A tab that hears no result in time reads itself.
 */
export type TabChannel = Pick<BroadcastChannel, 'postMessage' | 'close'> & { onmessage: ((event: MessageEvent) => void) | null }
type Message =
  | { type: 'claim'; key: string; id: string }
  | { type: 'result'; key: string; id: string; data: unknown; age: number | null }
  | { type: 'failed'; key: string; id: string }

/** Long enough for every tab woken by the same push to post its claim. */
export const CLAIM_WINDOW_MS = 30
/** A claim without a result after this is abandoned: read yourself. */
export const RESULT_TIMEOUT_MS = 8_000

type Waiter = { resolve: (value: { data: unknown; age: number | null } | null) => void }
export type TabShareClock = { now(): number; later(callback: () => void, ms: number): unknown; cancel(timer: unknown): void }
const browserClock: TabShareClock = { now: () => performance.now(), later: (callback, ms) => setTimeout(callback, ms), cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }

export class TabShare {
  private channel: TabChannel | null
  /** Remote claims seen per key (id → when), until their result or failure. */
  private claims = new Map<string, Map<string, number>>()
  private waiters = new Map<string, Set<Waiter>>()
  /** Reads this tab took from another tab. */
  adopted = 0

  constructor(name: string, open: (name: string) => TabChannel | null = name => typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name), private clock: TabShareClock = browserClock) {
    this.channel = open(name)
    if (this.channel) this.channel.onmessage = event => this.received(event.data as Message)
  }

  close() { this.channel?.close(); this.channel = null; for (const set of this.waiters.values()) for (const waiter of set) waiter.resolve(null); this.waiters.clear(); this.claims.clear() }

  private received(message: Message) {
    if (!message || typeof message !== 'object' || typeof message.key !== 'string' || typeof message.id !== 'string') return
    if (message.type === 'claim') {
      let claims = this.claims.get(message.key)
      if (!claims) this.claims.set(message.key, claims = new Map())
      claims.set(message.id, this.clock.now())
      return
    }
    this.claims.get(message.key)?.delete(message.id)
    const waiters = this.waiters.get(message.key)
    if (!waiters) return
    this.waiters.delete(message.key)
    for (const waiter of waiters) waiter.resolve(message.type === 'result' ? { data: message.data, age: message.age } : null)
  }

  private wait(key: string) {
    return new Promise<{ data: unknown; age: number | null } | null>(resolve => {
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

  /** `read` returns the key's new data; `adopt` stores another tab's result without reading. */
  async run<T>(key: string, read: () => Promise<T>, adopt: (data: T) => unknown): Promise<unknown> {
    const channel = this.channel
    if (!channel) return read()
    const take = async (value: { data: unknown; age: number | null } | null) => {
      if (!value) return read()
      this.adopted++
      return adopt(rebased(value.data, value.age, this.clock.now()) as T)
    }
    // Another tab is already reading this key: take its result.
    if (this.live(key).length) return take(await this.wait(key))
    const id = `${this.clock.now().toFixed(3)}:${Math.random().toString(36).slice(2)}`
    channel.postMessage({ type: 'claim', key, id } satisfies Message)
    let answered = false
    const result = this.wait(key).then(value => { answered = value !== null; return value })
    await new Promise(resolve => this.clock.later(() => resolve(undefined), CLAIM_WINDOW_MS))
    // Woken by the same push: the lowest claim reads; a result that already arrived is taken.
    if (answered || this.live(key).some(other => other < id)) return take(await result)
    this.waiters.get(key)?.clear()
    try {
      const data = await read()
      try { channel.postMessage({ type: 'result', key, id, data, age: age(data, this.clock.now()) } satisfies Message) }
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
