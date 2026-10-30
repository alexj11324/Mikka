import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { bearerToken, checkExpiry, createTokenInput, generatePersonalAccessToken, hashPersonalAccessToken, PAT_SHAPE, revokeTokenInput } from './format'

test('generated tokens: mkp_ shape, sha256 hash, 4-char hint, all distinct', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const { token, tokenHash, hint } = generatePersonalAccessToken()
    assert.match(token, PAT_SHAPE)
    assert.equal(tokenHash, hashPersonalAccessToken(token))
    assert.match(tokenHash, /^[a-f0-9]{64}$/)
    assert.ok(!tokenHash.includes(token.slice(4, 12)))
    assert.equal(hint, token.slice(-4))
    seen.add(token)
  }
  assert.equal(seen.size, 50)
})

test('create input: trimmed name 1..64, optional expiry, strict', () => {
  assert.deepEqual(createTokenInput.parse({ name: '  CI  ' }), { name: 'CI' })
  assert.equal(createTokenInput.parse({ name: 'x', expiresAt: null }).expiresAt, null)
  for (const bad of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(65) }, { name: 'x', expiresAt: 'tomorrow' }, { name: 'x', scope: 'all' }]) {
    assert.equal(createTokenInput.safeParse(bad).success, false, JSON.stringify(bad))
  }
  assert.equal(revokeTokenInput.safeParse({ id: 'nope' }).success, false)
})

test('expiry: none, future within 366 days; past or too far rejected', () => {
  const now = new Date('2026-10-30T00:00:00Z')
  assert.equal(checkExpiry(undefined, now), null)
  assert.equal(checkExpiry(null, now), null)
  assert.equal(checkExpiry('2026-11-29T00:00:00Z', now)?.toISOString(), '2026-11-29T00:00:00.000Z')
  assert.throws(() => checkExpiry('2026-10-30T00:00:00Z', now), /past/)
  assert.throws(() => checkExpiry('2027-11-01T00:00:00Z', now), /tooFar/)
})

test('bearer parsing only accepts our token shape', () => {
  const { token } = generatePersonalAccessToken()
  assert.equal(bearerToken(`Bearer ${token}`), token)
  for (const scheme of ['bearer', 'BEARER', 'BeArEr']) assert.equal(bearerToken(`${scheme} ${token}`), token, scheme)
  for (const bad of [null, '', token, `Basic ${token}`, `Bearer ${token} extra`, 'Bearer mkp_short']) assert.equal(bearerToken(bad), null, String(bad))
})

test('token auth middleware is not wired to any route yet', () => {
  const found = spawnSync('git', ['grep', '-l', '-E', "tokens/middleware|authenticatePersonalAccessToken", '--', 'app', 'lib', 'middleware.ts', 'proxy.ts', ':!lib/tokens/middleware.ts', ':!lib/tokens/*.test.ts'], { encoding: 'utf8' })
  assert.equal(found.status, 1, `unexpected users: ${found.stdout}`)
})
