/**
 * One family of springs for the app's own motion (#1386), close to UIKit's: let go and the view carries the
 * finger's speed, overshoots a little and settles quickly. Damping ratio ζ = damping / (2·√(stiffness·mass));
 * below 1 it bounces. Every caller keeps its Reduce Motion branch (no spring: it jumps to the end).
 */
/** A dragged message coming back (swipe to quote, the time reveal): ζ ≈ 0.73, about 4% overshoot, ~0.35 s. */
export const SNAP_BACK = { mass: 1, stiffness: 320, damping: 26 }
/** A new message arriving: rises 8 pt and fades in, ζ ≈ 0.8, ~0.3 s. */
export const ENTER = { mass: 1, stiffness: 380, damping: 31 }

/**
 * Rubber-band resistance, as UIScrollView past its edge: the further the drag, the less the view follows,
 * approaching `limit` without a hard stop. `x` and `limit` in points.
 */
export function rubberBand(x: number, limit: number, coefficient = 0.55) {
  'worklet'
  if (x <= 0) return 0
  return (1 - 1 / ((x * coefficient) / limit + 1)) * limit
}
