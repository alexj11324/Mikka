import assert from 'node:assert/strict'
import test from 'node:test'
import { ARRIVAL_MS, createArrivals } from './use-arrivals'

test('nothing arrives before or on the first load', () => {
  const arrivals = createArrivals()
  assert.equal(arrivals.arriving('a', 0), false)
  arrivals.commit(['a', 'b'], 100)
  assert.equal(arrivals.arriving('a', 100), false)
  assert.equal(arrivals.arriving('b', 5_000), false)
})

test('a later key arrives until its enter animation has run, then stays settled', () => {
  const arrivals = createArrivals()
  arrivals.commit(['a'], 0)
  // Rendered before its commit: arriving, so the first paint carries the enter class.
  assert.equal(arrivals.arriving('c', 1_000), true)
  arrivals.commit(['a', 'c'], 1_000)
  assert.equal(arrivals.arriving('c', 1_000 + ARRIVAL_MS - 1), true)
  assert.equal(arrivals.arriving('c', 1_000 + ARRIVAL_MS), false)
  // Committing it again does not restart it.
  arrivals.commit(['a', 'c'], 2_000)
  assert.equal(arrivals.arriving('c', 2_001), false)
})
