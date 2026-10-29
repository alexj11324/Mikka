import assert from 'node:assert/strict'
import { test } from 'node:test'
import { oauthResumePath, safeAuthReturn } from './auth-return'

const workspaceId = 'f6a2f5d8-1c08-4f20-9ba5-ffb596f2443c'
const issueId = 'e98b4c53-dc40-4c49-9d83-3af884c6e00e'

test('allows supported local destinations with validated settings context', () => {
  assert.equal(safeAuthReturn('/'), '/')
  assert.equal(safeAuthReturn('/settings?section=preferences'), '/settings?section=preferences')
  assert.equal(safeAuthReturn(`/settings?section=workspace&workspace=${workspaceId}`), `/settings?section=workspace&workspace=${workspaceId}`)
  assert.equal(safeAuthReturn('/settings?section=integrations'), '/settings?section=integrations')
  assert.equal(safeAuthReturn('/settings?section=account'), '/settings?section=account')
  assert.equal(safeAuthReturn(`/settings/teams?workspace=${workspaceId}&create=1`), `/settings/teams?workspace=${workspaceId}&create=1`)
  assert.equal(safeAuthReturn(`/settings/members?workspace=${workspaceId}&invite=1`), `/settings/members?workspace=${workspaceId}&invite=1`)
  assert.equal(safeAuthReturn(`/?issue=${issueId}`), `/?issue=${issueId}`)
  assert.equal(safeAuthReturn(`/invite/${'a'.repeat(64)}`), `/invite/${'a'.repeat(64)}`)
  assert.equal(safeAuthReturn('/devices'), '/devices')
  assert.equal(safeAuthReturn('/device'), '/device')
  assert.equal(safeAuthReturn('/device?user_code=ABCD-EFGH'), '/device?user_code=ABCD-EFGH')
  assert.equal(safeAuthReturn('/w/design-team'), '/w/design-team')
  assert.equal(safeAuthReturn('/workspaces/new'), '/workspaces/new')
  assert.equal(safeAuthReturn('/api/integrations/composio/callback'), '/api/integrations/composio/callback')
})

test('rejects external redirects, unsupported settings state, and malformed context', () => {
  assert.equal(safeAuthReturn('/w/design-team?next=https://attacker.example'), '/')
  assert.equal(safeAuthReturn('/w/a'), '/')
  assert.equal(safeAuthReturn('//attacker.example'), '/')
  assert.equal(safeAuthReturn('/device?user_code=ABCD-EFGH&next=https://attacker.example'), '/')
  assert.equal(safeAuthReturn('/device?user_code=ABCD&user_code=EFGH'), '/')
  assert.equal(safeAuthReturn('https://attacker.example'), '/')
  assert.equal(safeAuthReturn('/settings?section=administration'), '/')
  assert.equal(safeAuthReturn('/settings?next=https://attacker.example'), '/')
  assert.equal(safeAuthReturn('/settings/teams?workspace=not-a-uuid'), '/')
  assert.equal(safeAuthReturn('/settings/members?invite=0'), '/')
  assert.equal(safeAuthReturn('/settings/members?invite=1&invite=1'), '/')
  assert.equal(safeAuthReturn('/?issue=bad-id'), '/')
  assert.equal(safeAuthReturn('/api/integrations/composio/callback/other'), '/')
  assert.equal(safeAuthReturn('https://example.com/api/integrations/composio/callback'), '/')
})

test('OAuth resume URLs omit app-only parameters while preserving the signed request', () => {
  const path = oauthResumePath({ sig: 'signed', exp: '123', client_id: 'client', response_type: 'code', oauth: 'failed', continue: 'google', next: '/' })
  assert.equal(path, '/api/auth/oauth2/authorize?client_id=client&response_type=code')
})

test('returns to the plugins page and a known app page, nothing else', () => {
  assert.equal(safeAuthReturn('/?section=plugins'), '/?section=plugins')
  assert.equal(safeAuthReturn('/?section=plugins&app=gmail'), '/?section=plugins&app=gmail')
  assert.equal(safeAuthReturn('/?section=plugins&app=github'), '/')
  assert.equal(safeAuthReturn('/?section=plugins&app=gmail&next=//evil.test'), '/')
})
