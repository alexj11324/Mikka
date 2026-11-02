import test from 'node:test'
import assert from 'node:assert/strict'

import { STAPLE_RETRY_DELAYS, notaryAuth, requireNotaryAuth, runQuietly, secretValues, stapleWithRetry } from './notarize.mjs'

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

test('on CI missing credentials fail the build; only a local build may skip notarization', () => {
  assert.throws(() => requireNotaryAuth({ CI: 'true' }), /missing on CI/)
  assert.throws(() => requireNotaryAuth({ GITHUB_ACTIONS: 'true' }), /missing on CI/)
  assert.equal(requireNotaryAuth({}), null)
  assert.deepEqual(requireNotaryAuth({ CI: 'true', APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'T' }), ['--apple-id', 'a@b.c', '--password', 'p', '--team-id', 'T'])
})

test('a failed notarytool or stapler call reports its exit code and last stderr line, never a credential', async () => {
  const password = 'abcd-efgh-ijkl-mnop'
  const keyPath = '/tmp/runner/AuthKey_SECRET.p8'
  for (const auth of [
    ['--apple-id', 'dev@example.com', '--password', password, '--team-id', 'TEAM123'],
    ['--key', keyPath, '--key-id', 'KEYID99', '--issuer', 'issuer-uuid-1'],
  ]) {
    const secrets = secretValues(auth)
    assert.ok(secrets.length >= 2)
    // execFile's real error: the message repeats the whole command line; stderr may echo a value too.
    const exec = async (file, args) => {
      throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { code: 68, stderr: `progress\nError: could not reach ticket for ${auth[1]} (-1005)` })
    }
    for (const [label, args] of [['notarytool submit', ['notarytool', 'submit', 'Mikka.zip', ...auth, '--wait']], ['stapler staple', ['stapler', 'staple', 'Mikka.app']]]) {
      const error = await runQuietly(exec, label, 'xcrun', args, secrets).then(() => null, caught => caught)
      assert.ok(error instanceof Error)
      assert.match(error.message, new RegExp(`^${label} failed \\(exit 68\\): Error: could not reach ticket for \\*\\*\\* \\(-1005\\)$`))
      for (const value of [...secrets, password, keyPath]) assert.ok(!error.message.includes(value), `${label} leaked ${value}`)
      assert.ok(!error.message.includes('--password') && !error.message.includes('--key'))
    }
  }
})

test('the staple retry log carries only the quiet error message', async () => {
  const lines = []
  await assert.rejects(stapleWithRetry(async () => { throw new Error('stapler staple failed (exit 68): Error 68') }, { delays: [1], sleep: async () => {}, log: line => lines.push(line) }))
  assert.deepEqual(lines, ['staple attempt 1 failed (stapler staple failed (exit 68): Error 68); retrying in 1s'])
})

