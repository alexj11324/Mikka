import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTaskWorkspace } from './task-workspace-evidence.mjs'

test('legacy scope and creator never prove a tenant', () => {
  assert.deepEqual(resolveTaskWorkspace([], new Set(['personal'])), { workspaceId: null, reason: 'missing_evidence' })
})
test('one independently proved live workspace binds a task', () => {
  assert.deepEqual(resolveTaskWorkspace([{ source: 'team', workspaceId: 'shared' }, { source: 'bot', workspaceId: 'shared' }], new Set(['shared'])), { workspaceId: 'shared', reason: null })
})
test('contradictory evidence is quarantined even if one workspace was deleted', () => {
  assert.deepEqual(resolveTaskWorkspace([{ workspaceId: 'personal' }, { workspaceId: 'shared' }], new Set(['shared'])), { workspaceId: null, reason: 'conflicting_evidence' })
})
test('a deleted workspace does not redirect its tasks to the creator', () => {
  assert.deepEqual(resolveTaskWorkspace([{ workspaceId: 'removed' }], new Set(['personal'])), { workspaceId: null, reason: 'missing_workspace' })
})
test('a malformed authoritative relation quarantines the task even when its tenant exists', () => {
  assert.deepEqual(resolveTaskWorkspace([{ workspaceId: 'shared', verified: false }], new Set(['shared'])), { workspaceId: null, reason: 'conflicting_evidence' })
})
test('UUID capitalization is not a second tenant', () => {
  assert.deepEqual(resolveTaskWorkspace([{ workspaceId: 'ABCD' }, { workspaceId: 'abcd' }], new Set(['abcd'])), { workspaceId: 'abcd', reason: null })
})
test('invalid frozen provenance cannot disappear beside a valid source', () => {
  assert.deepEqual(resolveTaskWorkspace([{ source: 'team', workspaceId: 'shared' }, { source: 'execution_identity', workspaceId: 'invalid', verified: false }], new Set(['shared'])), { workspaceId: null, reason: 'conflicting_evidence' })
})
test('a removed referenced source quarantines rather than borrowing another source tenant', () => {
  assert.deepEqual(resolveTaskWorkspace([{ workspaceId: 'shared' }, { source: 'bot', workspaceId: null, verified: false }], new Set(['shared'])), { workspaceId: null, reason: 'conflicting_evidence' })
})
