import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkSnapshot, fingerprint, readMapToken, signMapToken, snapshotClaims } from './cursor'
import { mapQuerySchema } from './read-contracts'
const workspaceId = '00000000-0000-4000-8000-000000000001', projectId = '00000000-0000-4000-8000-000000000002'
const scope = { userId: 'reader', workspaceId, projectId }, query = mapQuerySchema.parse({ workspaceId })
const secret = 'isolated-unit-signing-secret'
test('map snapshots bind the reader, scope, layout and visible facts', () => {
  const claims = snapshotClaims(scope, query, fingerprint({ nodes: ['a'] }), 1000)
  const token = signMapToken(claims, secret)
  assert.deepEqual(readMapToken(token, scope, ['snapshot'], 2000, secret), claims)
  assert.throws(() => readMapToken(token, { ...scope, userId: 'other' }, ['snapshot'], 2000, secret), /map_not_found/)
  assert.throws(() => checkSnapshot(claims, fingerprint({ nodes: [] })), /map_snapshot_changed/)
  assert.throws(() => checkSnapshot(claims, claims.fingerprint, { ...query, laneLimit: 2 }), /map_snapshot_changed/)
  assert.throws(() => checkSnapshot(claims, claims.fingerprint, { ...query, q: 'new filter' }), /map_snapshot_changed/)
  checkSnapshot(claims, claims.fingerprint, { ...query, limit: 1 })
})
test('expired, forged, malformed and wrong-kind tokens retain distinct failures', () => {
  const claims = snapshotClaims(scope, query, fingerprint('facts'), 1000), token = signMapToken(claims, secret)
  assert.throws(() => readMapToken(token, scope, ['snapshot'], claims.expiresAt, secret), /map_snapshot_expired/)
  assert.throws(() => readMapToken(token + 'a', scope, ['snapshot'], 2000, secret), /map_invalid_request/)
  assert.throws(() => readMapToken(token, scope, ['page'], 2000, secret), /map_invalid_request/)
  assert.throws(() => readMapToken('not-a-token', scope, ['snapshot'], 2000, secret), /map_invalid_request/)
  assert.throws(() => signMapToken(claims, ''), /map_unavailable/)
})
test('query bounds reject invalid limits, unknown fields and inverted ranges', () => {
  for (const invalid of [{ limit: 101 }, { limit: 0 }, { laneLimit: 4 }, { ownerId: 'other' }, { q: 'x'.repeat(201) },
    { from: '2026-11-05T00:00:00Z', to: '2026-11-04T00:00:00Z' }])
    assert.equal(mapQuerySchema.safeParse({ workspaceId, ...invalid }).success, false)
})
