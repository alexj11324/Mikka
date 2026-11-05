import assert from 'node:assert/strict'
import test from 'node:test'
import { rubberBand, SMOOTH, SNAPPY } from '../lib/springs.ts'

const ratio = (spring: { mass: number; stiffness: number; damping: number }) => spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass))

test("springs are Apple's presets: SwiftUI .snappy (0.5 s, bounce 0.15) and .smooth (0.5 s, bounce 0)", () => {
  // Spring(duration:bounce:): stiffness (2π/d)², damping 4π(1 − bounce)/d, mass 1 — so the damping ratio is 1 − bounce.
  assert.equal(SNAPPY.mass, 1)
  assert.ok(Math.abs(SNAPPY.stiffness - (2 * Math.PI / 0.5) ** 2) < 1e-9)
  assert.ok(Math.abs(ratio(SNAPPY) - 0.85) < 1e-9)
  assert.ok(Math.abs(ratio(SMOOTH) - 1) < 1e-9)
})
test("the rubber band is UIScrollView's: follows less the further it goes, never stopping dead", () => {
  assert.equal(rubberBand(0, 56), 0)
  assert.equal(rubberBand(-10, 56), 0)
  const near = rubberBand(10, 56), far = rubberBand(200, 56)
  assert.ok(Math.abs(near - (10 * 56 * 0.55) / (56 + 0.55 * 10)) < 1e-9)
  assert.ok(far > near && far < 56)
})
