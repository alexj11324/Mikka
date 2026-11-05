/** How far (points) a message is dragged right, after the rubber band, before letting go quotes it. */
export const QUOTE_DISTANCE = 56
/** A quick flick quotes it from this far, when the finger leaves at least this fast (points per second). */
export const QUOTE_FLICK_DISTANCE = 24
export const QUOTE_FLICK_SPEED = 650

/** Whether letting go of a message dragged `distance` points at `velocity` points per second quotes it. */
export function quotes(distance: number, velocity: number) {
  'worklet'
  return distance >= QUOTE_DISTANCE || (distance >= QUOTE_FLICK_DISTANCE && velocity >= QUOTE_FLICK_SPEED)
}
