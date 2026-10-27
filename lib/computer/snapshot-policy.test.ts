import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dependencyFingerprint, SNAPSHOT_MAX_AGE_MS, snapshotRefreshReason } from './snapshot-policy'

test('dependency fingerprint is order independent and detects content and path changes', () => {
  const a = { path: 'a/pnpm-lock.yaml', contents: Buffer.from('alpha') }
  const b = { path: 'package-lock.json', contents: Buffer.from('beta') }
  const fingerprint = dependencyFingerprint([a, b])
  assert.equal(fingerprint, dependencyFingerprint([b, a]))
  assert.notEqual(fingerprint, dependencyFingerprint([a, { ...b, contents: Buffer.from('changed') }]))
  assert.notEqual(fingerprint, dependencyFingerprint([a, { ...b, path: 'other/package-lock.json' }]))
  assert.throws(() => dependencyFingerprint([a, a]), /Duplicate/)
})

test('a snapshot is refreshed on dependency or image changes, age, or invalid time', () => {
  const now = new Date('2026-10-27T12:00:00Z')
  const current = { dependencyFingerprint: 'a', sourceRevision: 'source', now }
  const fresh = { dependencyFingerprint: 'a', sourceRevision: 'source', createdAt: now }
  assert.equal(snapshotRefreshReason(null, current), 'missing')
  assert.equal(snapshotRefreshReason(fresh, current), null)
  assert.equal(snapshotRefreshReason({ ...fresh, dependencyFingerprint: 'b' }, current), 'dependencies')
  assert.equal(snapshotRefreshReason({ ...fresh, sourceRevision: 'old' }, current), 'source')
  assert.equal(snapshotRefreshReason({ ...fresh, createdAt: new Date(now.getTime() - SNAPSHOT_MAX_AGE_MS) }, current), 'expired')
  assert.equal(snapshotRefreshReason({ ...fresh, createdAt: new Date(now.getTime() + 1) }, current), 'expired')
  assert.equal(snapshotRefreshReason({ ...fresh, createdAt: new Date(NaN) }, current), 'expired')
})
