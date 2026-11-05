/**
 * The app's own motion uses Apple's published spring presets, converted exactly (expo-animation: "no approximated
 * values"). SwiftUI defines `Spring(duration:bounce:)` as mass 1, stiffness (2π / duration)² and
 * damping 4π · (1 − bounce) / duration, so its damping ratio is 1 − bounce; UIKit's
 * `UIView.animate(springDuration:bounce:)` takes the same two parameters. The values go to Reanimated as
 * mass/stiffness/damping, not as its own `duration`, whose settling model is not Apple's.
 *
 * Every caller keeps its Reduce Motion branch: there the value jumps to its end.
 */
function apple(duration: number, bounce: number) {
  return { mass: 1, stiffness: (2 * Math.PI / duration) ** 2, damping: (4 * Math.PI * (1 - bounce)) / duration }
}

/** SwiftUI `.snappy` (`Spring(duration: 0.5, bounce: 0.15)`): something the finger let go of, carrying its velocity. */
export const SNAPPY = apple(0.5, 0.15)
/** SwiftUI `.smooth` (`Spring(duration: 0.5, bounce: 0)`): motion no finger drove, so it does not overshoot. */
export const SMOOTH = apple(0.5, 0)

/**
 * UIScrollView's rubber band past an edge: `(x · d · c) / (d + c · x)` with c = 0.55, approaching `d` and never
 * stopping dead. `overshoot` and `dimension` in points.
 */
export function rubberBand(overshoot: number, dimension: number, constant = 0.55) {
  'worklet'
  if (overshoot <= 0) return 0
  return (overshoot * dimension * constant) / (dimension + constant * overshoot)
}
