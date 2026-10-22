import assert from 'node:assert/strict'
import test from 'node:test'
import { safeAuthReturn } from './auth-return'

const workspaceId = 'f6a2f5d8-1c08-4f20-9ba5-ffb596f2443c'
const issueId = 'e98b4c53-dc40-4c49-9d83-3af884c6e00e'

test('allows supported local app destinations with validated settings context', () => {
  assert.equal(safeAuthReturn('/'), '/')
  assert.equal(safeAuthReturn('/settings?section=preferences'), '/settings?section=preferences')
  assert.equal(safeAuthReturn(`/settings?section=workspace&workspace=${workspaceId}`), `/settings?section=workspace&workspace=${workspaceId}`)
  assert.equal(safeAuthReturn(`/settings/teams?workspace=${workspaceId}&create=1`), `/settings/teams?workspace=${workspaceId}&create=1`)
  assert.equal(safeAuthReturn(`/settings/members?workspace=${workspaceId}&invite=1`), `/settings/members?workspace=${workspaceId}&invite=1`)
  assert.equal(safeAuthReturn(`/?issue=${issueId}`), `/?issue=${issueId}`)
  assert.equal(safeAuthReturn(`/invite/${'a'.repeat(64)}`), `/invite/${'a'.repeat(64)}`)
  assert.equal(safeAuthReturn('/devices'), '/devices')
assert.equal(safeAuthReturn('/workspaces/new'), '/workspaces/new')
})

test('rejects external redirects, unsupported settings state, and malformed context', () => {
  assert.equal(safeAuthReturn('//attacker.example'), '/')
  assert.equal(safeAuthReturn('https://attacker.example'), '/')
  assert.equal(safeAuthReturn('/settings?section=administration'), '/')
  assert.equal(safeAuthReturn('/settings?next=https://attacker.example'), '/')
  assert.equal(safeAuthReturn('/settings/teams?workspace=not-a-uuid'), '/')
  assert.equal(safeAuthReturn('/settings/members?invite=0'), '/')
  assert.equal(safeAuthReturn('/settings/members?invite=1&invite=1'), '/')
  assert.equal(safeAuthReturn('/?issue=bad-id'), '/')
})
