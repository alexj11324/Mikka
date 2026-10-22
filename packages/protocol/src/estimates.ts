// How a team estimates an issue. A team picks one scale
// (`team.estimate_scale`, ADR 0058); the issue keeps the chosen value as a
// number in `issue.size_estimate.points`, so switching scales never rewrites
// or drops what was stored. The database, the mutators, MCP and the renderer
// all read the lists from here.

export const ESTIMATE_SCALES = ["off", "fibonacci", "linear", "tshirt"] as const

export type EstimateScale = (typeof ESTIMATE_SCALES)[number]

/** The scale a team starts on: today's fixed sidebar list. */
export const DEFAULT_ESTIMATE_SCALE: EstimateScale = "fibonacci"

/** Fibonacci points, the list the sidebar used before teams chose a scale. */
export const FIBONACCI_ESTIMATES = [0, 1, 2, 3, 5, 8] as const

/**
 * Linear points are 0 through this number. It matches Fibonacci's largest
 * tier so switching between the two keeps the same top end.
 */
export const LINEAR_MAX = 8

/** T-shirt tiers, smallest first. `points` is what the issue stores. */
export const TSHIRT_TIERS = [
  { key: "xs", label: "XS", points: 1 },
  { key: "s", label: "S", points: 2 },
  { key: "m", label: "M", points: 3 },
  { key: "l", label: "L", points: 5 },
  { key: "xl", label: "XL", points: 8 },
] as const

export type TshirtTier = (typeof TSHIRT_TIERS)[number]

/** Every value a scale may write, smallest first. `off` writes none. */
export function estimateValues(scale: EstimateScale): readonly number[] {
  switch (scale) {
    case "off":
      return []
    case "linear":
      return Array.from({ length: LINEAR_MAX + 1 }, (_, value) => value)
    case "tshirt":
      return TSHIRT_TIERS.map((tier) => tier.points)
    case "fibonacci":
      return FIBONACCI_ESTIMATES
  }
}

/** Whether a team on `scale` may store `points`. */
export function isEstimateValue(scale: EstimateScale, points: number): boolean {
  return estimateValues(scale).includes(points)
}

/** The T-shirt tier stored as `points`, when the scale has tiers. */
export function tshirtTierOf(points: number): TshirtTier | null {
  return TSHIRT_TIERS.find((tier) => tier.points === points) ?? null
}

/**
 * The tier a stored value is shown as after a scale change: the closest
 * value the current scale can write. Ties prefer the smaller tier, and a
 * scale with no values (`off`) has nothing to show.
 */
export function nearestEstimateValue(
  scale: EstimateScale,
  points: number
): number | null {
  let best: number | null = null
  for (const value of estimateValues(scale)) {
    if (best === null || Math.abs(value - points) < Math.abs(best - points)) {
      best = value
    }
  }
  return best
}

/**
 * The text a picked value shows. T-shirt uses its letters; the numeric
 * scales show the number. A stored value the scale cannot write any more
 * (for example 4 after switching to Fibonacci) shows the nearest tier, so
 * the row never reads a value the menu does not offer.
 */
export function estimateLabel(
  scale: EstimateScale,
  points: number
): string | null {
  if (scale === "off") return null
  const shown = nearestEstimateValue(scale, points)
  if (shown === null) return null
  if (scale !== "tshirt") return String(shown)
  return tshirtTierOf(shown)?.label ?? String(shown)
}

/**
 * Whether a stored value is still writable on `scale`. Values are kept when
 * a team switches scales; this only decides how the row reads.
 */
export function isCanonicalEstimate(
  scale: EstimateScale,
  points: number
): boolean {
  return isEstimateValue(scale, points)
}
