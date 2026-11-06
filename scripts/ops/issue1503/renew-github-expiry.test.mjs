import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { renewalFixture, renewalConnection, renewalAuthorization, renewalDuration } from './renew-github-expiry.mjs'

const now = Date.parse('2026-11-06T21:30:00Z')
const token = 'offline-test-child-token'
const state = { version: 1, issue: 1503, userId: 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3', ownerUserId: 'XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ',
  githubAccountId: '183887963', githubLogin: 'alexj11324', repository: 'alexj11324/Mikka-handoff', appId: '4840908', repositoryId: '1436202099',
  installationId: '173164679', listedRepositoryCount: 51, checkTokenScopeConfirmed: false,
  providerExpiresAt: '2026-11-07T02:21:59.000Z', connectionExpiresAt: '2026-11-06T22:21:50.684Z', connectionUpdatedAt: '2026-11-06T18:22:00.685Z',
  tokenSha256: createHash('sha256').update(token).digest('hex') }
const fixture = { issue: 1503, workspaceId: '93f38d33-9447-4eaf-8a46-0d8889165bcd', ownerUserId: state.ownerUserId, smokeUserId: state.userId, githubSetup: state }
const user = { id: 183887963, login: 'alexj11324', type: 'User' }
const repository = { id: 1436202099, full_name: 'alexj11324/Mikka-handoff', permissions: { push: true }, archived: false, disabled: false }
const checked = { app: { client_id: 'offline-app' }, token, scopes: [], expires_at: '2026-11-07T02:21:59Z' }

test('the actual check-token omission uses original mint evidence, never claims independent scope confirmation', () => {
  assert.equal(renewalFixture(fixture), state)
  const evidence = renewalAuthorization(state, 'offline-app', checked, user, repository, now)
  assert.equal(evidence.scopeMetadataAvailable, false)
  assert.equal(evidence.scopeMetadataValidated, false)
  assert.equal(evidence.scopeEvidence, 'original_scoped_mint_and_unchanged_token_sha256')
  const withoutExpiry = { ...checked }; delete withoutExpiry.expires_at
  assert.equal(renewalAuthorization(state, 'offline-app', withoutExpiry, user, repository, now).providerExpirySource, 'original_scoped_mint_receipt')
  for (const mutate of [
    input => { input.checked.token = 'another-child' },
    input => { input.checked.app.client_id = 'another-app' },
    input => { input.checked.user = { ...user, id: 99 } },
    input => { input.checked.scopes = ['repo'] },
    input => { input.checked.installation = { repository_selection: 'all', permissions: {} } },
    input => { input.checked.installation = { repository_selection: 'selected', permissions: { contents: 'admin' } } },
    input => { input.repository.id = 99 },
  ]) {
    const input = structuredClone({ checked, repository }); mutate(input)
    assert.throws(() => renewalAuthorization(state, 'offline-app', input.checked, user, input.repository, now), /issue1503_github_renewal_/)
  }
})

test('expiry extension respects both the four-hour local ceiling and original provider expiry', () => {
  const evidence = renewalAuthorization(state, 'offline-app', checked, user, repository, now)
  const duration = renewalDuration(state, evidence, now)
  assert.equal(duration.expiresIn, 4 * 60 * 60 - 10)
  const nearExpiry = Date.parse('2026-11-07T00:00:00Z')
  const capped = renewalDuration(state, evidence, nearExpiry)
  assert.equal(nearExpiry + capped.expiresIn * 1000, Date.parse(state.providerExpiresAt) - 10_000)
  const laterProvider = renewalAuthorization(state, 'offline-app', { ...checked, expires_at: '2026-11-08T02:00:00Z' }, user, repository, now)
  assert.equal(laterProvider.providerExpiresAt, state.providerExpiresAt)
  assert.throws(() => renewalAuthorization(state, 'offline-app', checked, user, repository, Date.parse('2026-11-07T01:00:00Z')), /provider_validity_insufficient/)
  assert.throws(() => renewalDuration({ ...state, connectionExpiresAt: state.providerExpiresAt }, evidence, now), /extension_unavailable/)
})

test('another connection, refresh grant or concurrent timestamp cannot satisfy the restoration fingerprint', () => {
  const row = { userId: state.userId, githubAccountId: state.githubAccountId, githubLogin: state.githubLogin, refreshToken: null,
    refreshTokenExpiresAt: null, updatedAt: new Date(state.connectionUpdatedAt), accessTokenExpiresAt: new Date(state.connectionExpiresAt) }
  renewalConnection(row, state)
  for (const changed of [
    { userId: state.ownerUserId }, { githubAccountId: '99' }, { githubLogin: 'someone-else' }, { refreshToken: 'test-refresh' },
    { updatedAt: new Date(now) }, { accessTokenExpiresAt: new Date(now) }, { refreshTokenExpiresAt: new Date(now) },
  ]) assert.throws(() => renewalConnection({ ...row, ...changed }, state), /connection_changed/)
  assert.throws(() => renewalFixture({ ...fixture, workspaceId: '00000000-0000-4000-8000-000000000000' }), /fixture_state_mismatch/)
})
