import { describe, expect, it } from "vitest"

import {
  DEFAULT_ESTIMATE_SCALE,
  ESTIMATE_SCALES,
  FIBONACCI_ESTIMATES,
  LINEAR_MAX,
  TSHIRT_TIERS,
  estimateLabel,
  estimateValues,
  isCanonicalEstimate,
  isEstimateValue,
  nearestEstimateValue,
  tshirtTierOf,
} from "./estimates"

describe("estimate scales", () => {
  it("starts a team on Fibonacci, today's fixed list", () => {
    expect(DEFAULT_ESTIMATE_SCALE).toBe("fibonacci")
    expect(estimateValues("fibonacci")).toEqual([...FIBONACCI_ESTIMATES])
  })

  it("writes 0 through 8 on linear", () => {
    expect(estimateValues("linear")).toEqual([
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      LINEAR_MAX,
    ])
  })

  it("maps the T-shirt tiers to points and never writes a value twice", () => {
    expect(estimateValues("tshirt")).toEqual([1, 2, 3, 5, 8])
    const points = TSHIRT_TIERS.map((tier) => tier.points)
    expect(new Set(points).size).toBe(points.length)
  })

  it("writes nothing when a team turns estimates off", () => {
    expect(estimateValues("off")).toEqual([])
    for (const scale of ESTIMATE_SCALES) {
      if (scale === "off") continue
      expect(isEstimateValue(scale, 3)).toBe(true)
    }
    expect(isEstimateValue("off", 3)).toBe(false)
  })

  it("refuses values outside the chosen scale", () => {
    // 4 is linear-only; 6 is linear-only; 9 is nobody's.
    expect(isEstimateValue("fibonacci", 4)).toBe(false)
    expect(isEstimateValue("tshirt", 4)).toBe(false)
    expect(isEstimateValue("fibonacci", 6)).toBe(false)
    expect(isEstimateValue("linear", 9)).toBe(false)
    expect(isEstimateValue("linear", 6)).toBe(true)
    expect(isEstimateValue("tshirt", 8)).toBe(true)
  })

  it("shows a kept value as the nearest tier after a scale switch", () => {
    // Linear's 4 after switching to Fibonacci: 3 and 5 tie, smaller wins.
    expect(nearestEstimateValue("fibonacci", 4)).toBe(3)
    // Fibonacci's 0 after switching to T-shirt: XS is closest.
    expect(nearestEstimateValue("tshirt", 0)).toBe(1)
    expect(nearestEstimateValue("tshirt", 4)).toBe(3)
    expect(nearestEstimateValue("off", 4)).toBeNull()
  })

  it("labels T-shirt values with their letters", () => {
    expect(estimateLabel("tshirt", 1)).toBe("XS")
    expect(estimateLabel("tshirt", 3)).toBe("M")
    expect(estimateLabel("tshirt", 8)).toBe("XL")
    expect(estimateLabel("tshirt", 4)).toBe("M")
    expect(estimateLabel("fibonacci", 5)).toBe("5")
    expect(estimateLabel("off", 5)).toBeNull()
    expect(tshirtTierOf(5)?.label).toBe("L")
    expect(tshirtTierOf(4)).toBeNull()
  })

  it("knows which stored values the current scale would accept", () => {
    expect(isCanonicalEstimate("linear", 4)).toBe(true)
    expect(isCanonicalEstimate("fibonacci", 4)).toBe(false)
    expect(isCanonicalEstimate("off", 0)).toBe(false)
  })
})
