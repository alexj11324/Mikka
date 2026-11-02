import test from 'node:test'
import assert from 'node:assert/strict'

import { STAPLE_RETRY_DELAYS, notaryAuth, stapleWithRetry } from './notarize.mjs'

test('staple retries back off for about five minutes', () => {
  const total = STAPLE_RETRY_DELAYS.reduce((sum, delay) => sum + delay, 0)
  assert.equal(STAPLE_RETRY_DELAYS.length, 6)
  assert.ok(total >= 240 && total <= 360, String(total))
  assert.deepEqual([...STAPLE_RETRY_DELAYS].sort((a, b) => a - b), STAPLE_RETRY_DELAYS)
})

test('a staple that fails twice then succeeds waits the first two delays', async () => {
  const waits = []
  let calls = 0
  const attempts = await stapleWithRetry(async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('x'), { stderr: 'Error 68' }) }, { sleep: async seconds => { waits.push(seconds) }, log: () => {} })
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [15, 30])
})

test('a staple that never succeeds throws the last error after every retry', async () => {
  const waits = []
  let calls = 0
  await assert.rejects(stapleWithRetry(async () => { calls += 1; throw new Error(`fail ${calls}`) }, { sleep: async seconds => { waits.push(seconds) }, log: () => {} }), /fail 7/)
  assert.equal(calls, 7)
  assert.deepEqual(waits, STAPLE_RETRY_DELAYS)
})

test('credentials come from the same variables electron-builder reads', () => {
  assert.equal(notaryAuth({}), null)
  assert.deepEqual(notaryAuth({ APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'T' }), ['--apple-id', 'a@b.c', '--password', 'p', '--team-id', 'T'])
  assert.deepEqual(notaryAuth({ APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' }), ['--key', '/k.p8', '--key-id', 'K', '--issuer', 'I'])
  assert.throws(() => notaryAuth({ APPLE_ID: 'a@b.c' }), /together/)
  assert.throws(() => notaryAuth({ APPLE_API_KEY_ID: 'K' }), /together/)
})
