// 停止 that fails or hangs says 「没停下 · 重试」 instead of leaving the chat stuck (usability review).
import assert from 'node:assert/strict'
import test from 'node:test'
import { composerStops, stopStuck, stopWithin } from '../lib/stop.ts'

test('a stop the server takes in time counts', async () => {
  assert.equal(await stopWithin(async () => ({ stopped: true }), 50), true)
})

test('a stop request that fails does not count', async () => {
  assert.equal(await stopWithin(async () => { throw new Error('http500') }, 50), false)
})

test('a stop request that takes longer than the cap does not count', async () => {
  assert.equal(await stopWithin(() => new Promise(resolve => setTimeout(resolve, 200)), 20), false)
})

test('the chat says it did not stop when the request failed or the reply still works after the cap', () => {
  assert.equal(stopStuck(null, true, 0), false)
  assert.equal(stopStuck({ at: 0, failed: true }, true, 1), true)
  assert.equal(stopStuck({ at: 0, failed: false }, true, 9_999), false)
  assert.equal(stopStuck({ at: 0, failed: false }, true, 10_000), true)
  assert.equal(stopStuck({ at: 0, failed: true }, false, 20_000), false)
})

test('a thread waiting for your answer sends; only a working one turns send into stop', () => {
  assert.equal(composerStops({ active: true, working: true }), true)
  assert.equal(composerStops({ active: true, working: false }), false, 'waiting_input')
  assert.equal(composerStops({ active: true }), false, 'a server that does not say working')
  assert.equal(composerStops({ active: false, working: false }), false)
})
