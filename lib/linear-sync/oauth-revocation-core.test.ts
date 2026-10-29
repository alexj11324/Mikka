import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLinearOAuthRevocationProcessor } from './oauth-revocation-core'

test('only a recognized OAuth revoke action reaches the revocation store', async () => {
  const calls: unknown[][] = []
  const process = createLinearOAuthRevocationProcessor({
    revokeAuthorization: async (...args) => { calls.push(['authorization', ...args]) },
    revokeOrganization: async (...args) => { calls.push(['organization', ...args]) },
  })
  assert.equal(await process({ type: 'Issue', action: 'remove', organizationId: 'org', data: {} }), false)
  assert.equal(await process({ type: 'OAuthAuthorization', action: 'update', organizationId: 'org', data: { userId: 'user' } }), false)
  assert.equal(calls.length, 0)
  assert.equal(await process({ type: 'OAuthAuthorization', action: 'remove', organizationId: ' org ', data: { userId: ' user ' } }), true)
  assert.equal(await process({ type: 'OAuthApp', action: 'revoked', organizationId: ' org ' }), true)
  assert.deepEqual(calls, [['authorization', 'org', 'user'], ['organization', 'org']])
})

test('malformed signed revocation data fails closed without changing local state', async () => {
  let calls = 0
  const process = createLinearOAuthRevocationProcessor({
    revokeAuthorization: async () => { calls++ },
    revokeOrganization: async () => { calls++ },
  })
  await assert.rejects(process({ type: 'OAuthAuthorization', action: 'remove', organizationId: 'org', data: {} }), /missing its user/)
  await assert.rejects(process({ type: 'OAuthApp', action: 'revoke', organizationId: ' ' }), /missing its organization/)
  assert.equal(calls, 0)
})
