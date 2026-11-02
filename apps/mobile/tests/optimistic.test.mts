// A switch on a bot's page goes back when its save fails (usability review).
import assert from 'node:assert/strict'
import test from 'node:test'
import { saveOptimistic } from '../lib/optimistic.ts'

test('a saved change stays', async () => {
  let pinned = false
  assert.equal(await saveOptimistic(() => { pinned = true }, async () => undefined, () => { pinned = false }), true)
  assert.equal(pinned, true)
})

test('a change whose save fails goes back', async () => {
  let pinned = false
  assert.equal(await saveOptimistic(() => { pinned = true }, async () => { throw new Error('http500') }, () => { pinned = false }), false)
  assert.equal(pinned, false)
})
