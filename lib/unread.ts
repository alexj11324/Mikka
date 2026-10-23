/** Pure logic for MIK-8 unread indicators. Positions are integers; never compare message ids. */

export type UnreadItem = { position: number; own: boolean }

/** Forward-only read position: an older position never wins. */
export function mergeReadPosition(current: number | null, next: number | null): number | null {
  if (next === null) return current
  if (current === null) return next
  return Math.max(current, next)
}

/**
 * Where the 「新」 divider goes: before the first message newer than the read position
 * that someone else sent. No read record yet (first visit) or nothing unread → no divider.
 */
export function dividerPosition(items: UnreadItem[], lastReadPosition: number | null): number | null {
  if (lastReadPosition === null) return null
  return items.find(item => item.position > lastReadPosition && !item.own)?.position ?? null
}

/** Top pill N: unread messages (not own) at or below the divider. */
export function unreadBelowDivider(items: UnreadItem[], divider: number | null): number {
  if (divider === null) return 0
  return items.filter(item => item.position >= divider && !item.own).length
}

/** Bottom pill N: messages from others that arrived after the user left the bottom. */
export function arrivedSinceLeftBottom(items: UnreadItem[], leftBottomAt: number | null): number {
  if (leftBottomAt === null) return 0
  return items.filter(item => item.position > leftBottomAt && !item.own).length
}

export function formatCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export type Box = { top: number; bottom: number }

/**
 * Half-visible rule: a message counts as seen when at least half of it is inside the
 * viewport. A message taller than the viewport counts once it fills at least half
 * of the viewport (otherwise it could never qualify).
 */
export function isHalfVisible(item: Box, viewport: Box): boolean {
  const height = item.bottom - item.top
  if (height <= 0) return false
  const visible = Math.min(item.bottom, viewport.bottom) - Math.max(item.top, viewport.top)
  if (visible <= 0) return false
  return visible >= Math.min(height, viewport.bottom - viewport.top) / 2
}

/** The read position to report: the last (highest) half-visible message. */
export function lastVisiblePosition(items: (Box & { position: number })[], viewport: Box): number | null {
  let last: number | null = null
  for (const item of items) if (isHalfVisible(item, viewport)) last = mergeReadPosition(last, item.position)
  return last
}

type Timers = { now: () => number; setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void }
const realTimers: Timers = { now: () => Date.now(), setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: id => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>) }

/**
 * Throttled, forward-only read reporter. `report` sends at most once per `intervalMs`
 * (leading + trailing). `flush` sends any pending position immediately through
 * `sendNow` (beacon/keepalive) — used on visibilitychange→hidden and unmount.
 */
export function createReadReporter<T extends { position: number }>(options: {
  intervalMs?: number
  send: (target: T) => void
  sendNow?: (target: T) => void
  timers?: Timers
}) {
  const interval = options.intervalMs ?? 2000
  const timers = options.timers ?? realTimers
  let sent: number | null = null
  let pending: T | null = null
  let lastSentAt = -Infinity
  let timer: unknown = null

  function fire(via: (target: T) => void) {
    if (timer !== null) { timers.clearTimeout(timer); timer = null }
    if (!pending) return
    const target = pending
    pending = null
    sent = target.position
    lastSentAt = timers.now()
    via(target)
  }
  return {
    report(target: T) {
      if (sent !== null && target.position <= sent) return
      if (pending && target.position <= pending.position) return
      pending = target
      const wait = lastSentAt + interval - timers.now()
      if (wait <= 0) fire(options.send)
      else if (timer === null) timer = timers.setTimeout(() => { timer = null; fire(options.send) }, wait)
    },
    flush() { fire(options.sendNow ?? options.send) },
    get sentPosition() { return sent },
  }
}
