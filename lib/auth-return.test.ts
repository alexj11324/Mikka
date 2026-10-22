import assert from 'node:assert/strict'
import { test } from 'node:test'
import { oauthResumePath, safeAuthReturn } from './auth-return'

test('only allows the fixed Composio callback as an API auth return', () => {
  assert.equal(safeAuthReturn('/api/integrations/composio/callback'), '/api/integrations/composio/callback')
  assert.equal(safeAuthReturn('/api/integrations/composio/callback/other'), '/')
  assert.equal(safeAuthReturn('https://example.com/api/integrations/composio/callback'), '/')
})

test('OAuth resume URLs omit app-only parameters while preserving the signed request', () => {
  const path = oauthResumePath({ sig: 'signed', exp: '123', client_id: 'client', response_type: 'code', oauth: 'failed', continue: 'google', next: '/' })
  assert.equal(path, '/api/auth/oauth2/authorize?client_id=client&response_type=code')
})
