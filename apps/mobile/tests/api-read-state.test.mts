import assert from 'node:assert/strict'
import test from 'node:test'
import { needsForegroundRead } from '../lib/api-read-state.ts'

test('returning to the app recovers failed and never-completed reads without a successful timestamp', () => {
  assert.equal(needsForegroundRead(0, true, 20_000, 60_000), true)
  assert.equal(needsForegroundRead(0, false, 20_000, 60_000), true)
  assert.equal(needsForegroundRead(10_000, true, 20_000, 60_000), true)
})
test('successful reads retain the one-minute foreground freshness window', () => {
  assert.equal(needsForegroundRead(10_000, false, 69_999, 60_000), false)
  assert.equal(needsForegroundRead(10_000, false, 70_000, 60_000), true)
})
