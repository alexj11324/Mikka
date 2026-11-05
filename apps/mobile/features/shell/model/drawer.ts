/**
 * The push drawer's geometry and release rule (#1408 Phase 2). The drawer lies under the app at the left edge; the
 * app's surface slides right by the drawer's width to show it.
 */

/** The drawer is as wide as the screen less a strip of the app left in view, between 280 and 360 points. */
export function drawerWidth(screenWidth: number): number {
  return Math.min(360, Math.max(280, screenWidth - 52))
}

/** The surface's corners while open follow the screen's own, never under 34 points. */
export function surfaceRadius(insets: { top: number; bottom: number }): number {
  return Math.max(34, insets.top, insets.bottom)
}

/** The drag that opens the drawer: it starts after 12 points to the right and gives way to 10 points up or down. */
export const OPEN_PAN = { activeX: 12, failX: -10, failY: 10 } as const
/** The drag that closes it, on the moved surface: 8 points to the left, giving way to 12 up or down. */
export const CLOSE_PAN = { activeX: -8, failX: 12, failY: 12 } as const

/** The drawer's spring: about 300 ms, no overshoot. */
export const DRAWER_SPRING = { duration: 300, dampingRatio: 0.8, overshootClamping: true } as const

/** The share of the opening at which the surface has its full corner radius. */
export const ROUNDED_AT = 0.15

/**
 * How small the open surface is. A full-height slide hides its rounded corners on the phone's own bezel, so the
 * open surface shrinks just enough for those corners to sit inside the screen. It is not a detached modal.
 */
export const OPEN_SCALE = 0.96

/** 1 when closed, `OPEN_SCALE` when open. */
export function surfaceScale(progress: number): number {
  'worklet'
  return 1 - (1 - OPEN_SCALE) * progress
}

/** Opacity of the `drawerDim` veil: none when closed, the token's own strength when open. */
export function surfaceDim(progress: number): number {
  'worklet'
  return progress
}

/**
 * Where a released drag settles. `progress` is how far open the drawer is (0–1) and `velocity` the finger's speed
 * in drawer widths per second; the drawer settles where it would be a fifth of a second on, open past halfway.
 */
export function settlesOpen(progress: number, velocity: number): boolean {
  'worklet'
  return progress + velocity * 0.2 > 0.5
}

/** How far open a drag leaves the drawer, from where it started (0 closed, 1 open) and the finger's travel. */
export function dragProgress(start: 0 | 1, translationX: number, width: number): number {
  'worklet'
  return Math.min(1, Math.max(0, start + translationX / width))
}
