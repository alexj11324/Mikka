// A reply slow to start says so after 30 seconds, with the time it has waited (Figma 843:2 #1).
import assert from 'node:assert/strict'
import test from 'node:test'
import { waitingLabel } from '../lib/waiting.ts'

test('the spinner stays alone for the first 30 seconds, then counts', () => {
  assert.equal(waitingLabel(0, 29_999), null)
  assert.equal(waitingLabel(0, 30_000), '等待回复 · 30 秒')
  assert.equal(waitingLabel(0, 72_400), '等待回复 · 1 分 12 秒')
  assert.equal(waitingLabel(0, 120_000), '等待回复 · 2 分 0 秒')
})
