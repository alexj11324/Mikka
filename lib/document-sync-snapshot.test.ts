import assert from 'node:assert/strict'
import test from 'node:test'
import { nextSyncSnapshot, type SyncSnapshot } from './document-sync-snapshot'

const idle: SyncSnapshot = { ready: true, pending: false, error: false, syncing: false }

test('document sync notifies only when the visible snapshot changes', () => {
  assert.equal(nextSyncSnapshot(idle, { pending: false }), null)
  assert.deepEqual(nextSyncSnapshot(idle, { pending: true }), { ready: true, pending: true, error: false, syncing: false })
  const pending = nextSyncSnapshot(idle, { pending: true })
  assert.ok(pending)
  assert.equal(nextSyncSnapshot(pending, { pending: true }), null)
  assert.deepEqual(nextSyncSnapshot(pending, { syncing: false, error: false }), null)
  assert.deepEqual(nextSyncSnapshot(pending, { error: true }), { ready: true, pending: true, error: true, syncing: false })
})


test('only a changed authorized workspace moves the live document subscription', () => {
  const first = nextSyncSnapshot(idle, { workspaceId: 'workspace-a' })!
  assert.equal(first.workspaceId, 'workspace-a')
  assert.equal(nextSyncSnapshot(first, { workspaceId: 'workspace-a' }), null)
  assert.equal(nextSyncSnapshot(first, { workspaceId: undefined }), null)
  const revoked = nextSyncSnapshot(first, { workspaceId: null })!
  assert.equal(revoked.workspaceId, null)
  assert.equal(nextSyncSnapshot(revoked, { workspaceId: 'workspace-b' })?.workspaceId, 'workspace-b')
})
