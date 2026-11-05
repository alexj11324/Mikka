/**
 * Swipe a chat row toward the leading edge to pin it (#1408). The action is in view at 88 points and runs at 144.
 * A trailing swipe on a closed row is the drawer's, not the row's; on an open row it closes the row.
 */

export const PIN_REVEAL = 88
export const PIN_COMMIT = 144

export type PinRest = 'closed' | 'reveal' | 'commit'

/** How far `translationX` travels toward the leading edge. Always zero or more. */
export function leadingTravel(translationX: number, rtl: boolean): number {
  const toward = rtl ? translationX : -translationX
  return toward > 0 ? toward : 0
}

/** How far `translationX` travels toward the trailing edge. Always zero or more. */
export function trailingTravel(translationX: number, rtl: boolean): number {
  const toward = rtl ? -translationX : translationX
  return toward > 0 ? toward : 0
}

/**
 * Where a released pin swipe rests. `distance` is how far the row is toward the leading edge, `velocity` the
 * finger's speed that way (points per second). A flick carries it the way a short release would not.
 */
export function pinSwipeRest(distance: number, velocity: number, wasOpen: boolean): PinRest {
  const projected = distance + Math.max(0, velocity) * 0.12
  if (projected >= PIN_COMMIT) return 'commit'
  if (projected >= PIN_REVEAL * 0.5 || (wasOpen && distance > 24)) return 'reveal'
  return 'closed'
}

/** True the moment `after` reaches `at` from below. */
export function crossed(before: number, after: number, at: number): boolean {
  return before < at && after >= at
}

export type PinOutcome = 'pin' | 'unpin' | 'limit'

/**
 * What a committed pin swipe does. Unpinning always works. Pinning works unless a cap is already full.
 * Mikka has no cap: pass `limit` null and this never returns `limit`.
 */
export function pinOutcome(pinned: boolean, pinnedCount: number, limit: number | null): PinOutcome {
  if (pinned) return 'unpin'
  if (limit !== null && pinnedCount >= limit) return 'limit'
  return 'pin'
}

/** The row's offset once it rests, in points toward the leading edge. */
export function pinOffset(rest: PinRest): number {
  if (rest === 'reveal') return PIN_REVEAL
  if (rest === 'commit') return 0
  return 0
}
