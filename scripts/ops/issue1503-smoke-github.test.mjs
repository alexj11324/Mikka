import assert from 'node:assert/strict'
import test from 'node:test'
import { createSmokeGitHubFixture, SMOKE_USER_ID, OWNER_USER_ID, GITHUB_ACCOUNT_ID, GITHUB_LOGIN, OWNER_MIN_VALIDITY_MS, REPOSITORY } from './issue1503-smoke-github.mjs'

const NOW = Date.parse('2026-11-06T18:00:00Z')
const SOURCE_TOKEN = 'synthetic-owner-access-token'
const SCOPED_TOKEN = 'synthetic-new-scoped-access-token'
const SECRET = 'synthetic-app-client-secret'
const ownerUserId = OWNER_USER_ID
const permissions = { metadata: 'read', contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read' }
const githubUser = { id: Number(GITHUB_ACCOUNT_ID), login: GITHUB_LOGIN, type: 'User' }
const repo = { id: 1503, full_name: REPOSITORY, permissions: { push: true }, archived: false }
const installation = { id: 123, app_id: 456, client_id: 'fixture-client', account: githubUser, suspended_at: null }

function fixture({ vacant = true, source = {}, minted = {}, appId = '456', response: changeResponse, saveError, afterSaveError, disconnectError } = {}) {
  const calls = [], saved = [], revoked = [], disconnected = []
  let exists = !vacant, stored = null, ownerCalls = 0, now = NOW
  const credentials = {
    assertVacant: async () => { if (exists) throw Object.assign(new Error('preexisting'), { synthetic: true }) },
    githubTokenForUser: async (id, options) => {
      ownerCalls++
      assert.equal(id, ownerUserId)
      assert.deepEqual(options, { minValidityMs: OWNER_MIN_VALIDITY_MS })
      return { token: SOURCE_TOKEN, githubAccountId: GITHUB_ACCOUNT_ID, expiresAt: new Date(NOW + 6 * 60 * 60_000), ...source }
    },
    saveIfVacant: async input => {
      if (saveError) throw saveError
      assert.equal(exists, false)
      assert.equal(input.token, SCOPED_TOKEN)
      assert.deepEqual(Object.keys(input).sort(), ['expiresIn', 'providerExpiry', 'token', 'tokenSha256'])
      saved.push(input)
      stored = { token: input.token, digest: input.tokenSha256 }
      exists = true
      if (afterSaveError) throw afterSaveError
      return { updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + input.expiresIn * 1000).toISOString() }
    },
    readMatchingToken: async state => {
      if (!stored) return null
      assert.equal(state.tokenSha256, stored.digest)
      return stored.token
    },
    discardIfNew: async fingerprint => {
      if (stored?.digest === fingerprint) { disconnected.push(SMOKE_USER_ID); stored = null; exists = false }
    },
    disconnectMatching: async state => {
      if (disconnectError) throw disconnectError
      assert.equal(state.userId, SMOKE_USER_ID)
      disconnected.push(state.userId)
      exists = false; stored = null
    },
  }
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname, scoped = init.headers.authorization === `Bearer ${SCOPED_TOKEN}`
    calls.push({ url, init })
    assert.equal(new URL(url).origin, 'https://api.github.com')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    let body, status = 200
    if (path === '/applications/fixture-client/token/scoped') {
      assert.equal(init.method, 'POST')
      assert.equal(init.headers.authorization, `Basic ${Buffer.from('fixture-client:' + SECRET).toString('base64')}`)
      assert.deepEqual(JSON.parse(init.body), { access_token: SOURCE_TOKEN, target: GITHUB_LOGIN, repositories: ['Mikka-handoff'], permissions })
      body = { token: SCOPED_TOKEN, expires_at: new Date(NOW + 8 * 60 * 60_000).toISOString(), app: { client_id: 'fixture-client' }, user: githubUser,
        installation: { repository_selection: 'selected', permissions }, ...minted }
    } else if (path === '/applications/fixture-client/token' && init.method === 'POST') {
      assert.equal(JSON.parse(init.body).access_token, SOURCE_TOKEN)
      assert.equal(init.headers.authorization, `Basic ${Buffer.from('fixture-client:' + SECRET).toString('base64')}`)
      body = { app: { client_id: 'fixture-client', name: 'Mikka', url: 'https://github.com/apps/example' }, user: githubUser }
    } else if (path === '/applications/fixture-client/token') {
      assert.equal(init.method, 'DELETE')
      assert.equal(JSON.parse(init.body).access_token, SCOPED_TOKEN, 'only the newly minted token may be revoked')
      revoked.push(JSON.parse(init.body).access_token)
      status = 204
    } else if (path === '/user') body = githubUser
    else if (path === '/repos/' + REPOSITORY) body = repo
    else if (path === '/user/installations') body = { installations: [installation] }
    else if (path === '/user/installations/123/repositories') body = { repositories: [repo] }
    else assert.fail('unexpected request')
    const changed = await changeResponse?.({ path, scoped, init, body, status })
    if (changed) ({ body = body, status = status } = changed)
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  const api = createSmokeGitHubFixture({ application: { clientId: 'fixture-client', clientSecret: SECRET }, appId, fetchImpl, now: () => now, credentials })
  return { api, calls, saved, revoked, disconnected, get ownerCalls() { return ownerCalls }, set now(value) { now = value } }
}

test('authorized setup retains real user identity, narrow repository scope and finite expiry; cleanup is idempotent', async () => {
  const f = fixture()
  const result = await f.api.setup({ ownerUserId })
  assert.equal(result.state.userId, SMOKE_USER_ID)
  assert.equal(result.state.githubAccountId, GITHUB_ACCOUNT_ID)
  assert.equal(result.state.repository, REPOSITORY)
  assert.equal(result.state.appId, '456')
  assert.equal(result.state.repositoryId, '1503')
  assert.equal(result.state.installationId, '123')
  assert.ok(Date.parse(result.state.connectionExpiresAt) < NOW + 4 * 60 * 60_000)
  assert.ok(Date.parse(result.state.connectionExpiresAt) <= Date.parse(result.state.providerExpiresAt))
  assert.equal(f.saved.length, 1)
  const serialized = JSON.stringify(result)
  for (const secret of [SOURCE_TOKEN, SCOPED_TOKEN, SECRET]) assert.ok(!serialized.includes(secret))
  assert.deepEqual(await result.cleanup(), { userId: SMOKE_USER_ID, revoked: true, disconnected: true })
  await result.cleanup()
  assert.deepEqual(f.revoked, [SCOPED_TOKEN])
  assert.deepEqual(f.disconnected, [SMOKE_USER_ID])
})

test('safe recovery state can locate only the exact sealed smoke credential', async () => {
  const f = fixture(), { state } = await f.api.setup({ ownerUserId })
  assert.deepEqual(await f.api.cleanup(JSON.parse(JSON.stringify(state))), { userId: SMOKE_USER_ID, revoked: true, disconnected: true })
  assert.deepEqual(f.revoked, [SCOPED_TOKEN])
})

for (const options of [{ ownerUserId, smokeUserId: 'another-user' }, { ownerUserId: SMOKE_USER_ID }, { ownerUserId: 'another-owned-alias' }, { ownerUserId, repository: 'alexj11324/Mikka' }]) {
  test(`refuses a different fixture target: ${JSON.stringify(options)}`, async () => {
    const f = fixture()
    await assert.rejects(f.api.setup(options), { code: 'fixture_target_mismatch' })
    assert.equal(f.ownerCalls, 0); assert.equal(f.calls.length, 0)
  })
}

test('a preexisting smoke connection is rejected before obtaining Owner credentials', async () => {
  const f = fixture({ vacant: false })
  await assert.rejects(f.api.setup({ ownerUserId }), { code: 'dependency_failed' })
  assert.equal(f.ownerCalls, 0); assert.equal(f.calls.length, 0)
})

for (const source of [{ githubAccountId: '999' }, { expiresAt: new Date(NOW + 60_000) }, { expiresAt: 'invalid' }]) {
  test(`refuses invalid source credential metadata: ${JSON.stringify(source)}`, async () => {
    const f = fixture({ source })
    await assert.rejects(f.api.setup({ ownerUserId }), { code: 'owner_credential_invalid' })
    assert.equal(f.calls.length, 0)
  })
}

test('Owner /user must actually be Alex, not merely the stored identity', async () => {
  const f = fixture({ response: ({ path, scoped, body }) => path === '/user' && !scoped ? { body: { ...body, login: 'not-alex' } } : null })
  await assert.rejects(f.api.setup({ ownerUserId }), { code: 'identity_mismatch' })
  assert.equal(f.saved.length, 0); assert.equal(f.revoked.length, 0)
})

test('a bogus scoped response returning the source token never revokes it', async () => {
  const f = fixture({ minted: { token: SOURCE_TOKEN } })
  await assert.rejects(f.api.setup({ ownerUserId }), { code: 'scoped_token_not_distinct' })
  assert.equal(f.saved.length, 0); assert.equal(f.revoked.length, 0)
})

for (const [minted, code] of [
  [{ expires_at: null }, 'scoped_expiry_invalid'],
  [{ expires_at: new Date(NOW + 60_000).toISOString() }, 'scoped_expiry_invalid'],
  [{ app: { client_id: 'another-app' } }, 'scoped_app_mismatch'],
  [{ user: { ...githubUser, id: 999 } }, 'identity_mismatch'],
  [{ installation: { repository_selection: 'all', permissions } }, 'scope_not_selected'],
  [{ installation: { repository_selection: 'selected', permissions: { ...permissions, administration: 'write' } } }, 'scope_permissions_mismatch'],
]) {
  test(`rejects ${code} and revokes only the new token`, async () => {
    const f = fixture({ minted })
    await assert.rejects(f.api.setup({ ownerUserId }), { code })
    assert.equal(f.saved.length, 0)
    assert.deepEqual(f.revoked, [SCOPED_TOKEN])
    assert.equal(f.disconnected.length, 0)
  })
}

test('scoped token must still support the actual product installation listing', async () => {
  const f = fixture({ response: ({ path, scoped }) => path === '/user/installations' && scoped ? { status: 403, body: { message: SCOPED_TOKEN } } : null })
  await assert.rejects(f.api.setup({ ownerUserId }), error => {
    assert.equal(error.code, 'provider_http'); assert.equal(error.details.stage, 'scoped_installations')
    assert.ok(!JSON.stringify(error).includes(SCOPED_TOKEN))
    return true
  })
  assert.deepEqual(f.revoked, [SCOPED_TOKEN]); assert.equal(f.saved.length, 0)
})

test('a token that can enumerate an extra repository is refused', async () => {
  const f = fixture({ response: ({ path, scoped }) => path.endsWith('/repositories') && scoped ? { body: { repositories: [repo, { id: 1488, full_name: 'alexj11324/Mikka' }] } } : null })
  await assert.rejects(f.api.setup({ ownerUserId }), { code: 'scope_exceeded' })
  assert.deepEqual(f.revoked, [SCOPED_TOKEN]); assert.equal(f.saved.length, 0)
})

test('a persistence failure revokes the minted token and redacts raw database causes', async () => {
  const f = fixture({ saveError: new Error('insert query secret=' + SCOPED_TOKEN) })
  await assert.rejects(f.api.setup({ ownerUserId }), error => {
    assert.equal(error.code, 'dependency_failed')
    assert.ok(!JSON.stringify(error).includes(SCOPED_TOKEN)); assert.ok(!String(error).includes(SCOPED_TOKEN))
    return true
  })
  assert.deepEqual(f.revoked, [SCOPED_TOKEN]); assert.equal(f.disconnected.length, 0)
})

test('provider transport errors cannot expose credentials or request bodies', async () => {
  const f = fixture({ response: () => { throw new Error(SOURCE_TOKEN + SECRET) } })
  await assert.rejects(f.api.setup({ ownerUserId }), error => {
    assert.equal(error.code, 'provider_transport')
    assert.ok(!JSON.stringify(error).includes(SOURCE_TOKEN)); assert.ok(!String(error).includes(SECRET))
    return true
  })
})

test('a lost acknowledgement after saving rolls back only the new fingerprint', async () => {
  const f = fixture({ afterSaveError: new Error('commit response lost') })
  await assert.rejects(f.api.setup({ ownerUserId }), { code: 'dependency_failed' })
  assert.deepEqual(f.revoked, [SCOPED_TOKEN]); assert.deepEqual(f.disconnected, [SMOKE_USER_ID])
})

test('explicit none permissions do not expand the requested scope', async () => {
  const f = fixture({ minted: { installation: { repository_selection: 'selected', permissions: { ...permissions, administration: 'none' } } } })
  const result = await f.api.setup({ ownerUserId })
  await result.cleanup()
  assert.equal(f.saved.length, 1)
})

test('discovers the public app ID by matching client_id when Check-token has no app.id', async () => {
  const f = fixture({ appId: null })
  const result = await f.api.setup({ ownerUserId })
  assert.equal(result.state.appId, '456')
  assert.equal(f.ownerCalls, 1, 'discovery must not refresh or obtain the Owner credential twice')
  await result.cleanup()
})

test('accepts optional null authorization user metadata only after live /user verification', async () => {
  const f = fixture({ appId: null, minted: { user: null }, response: ({ path, init, body }) => path === '/applications/fixture-client/token' && init.method === 'POST' ? { body: { ...body, user: null } } : null })
  const result = await f.api.setup({ ownerUserId })
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/user').length, 2)
  await result.cleanup()
})

test('refuses a Check-token client mismatch before minting', async () => {
  const f = fixture({ appId: null, response: ({ path, init, body }) => path === '/applications/fixture-client/token' && init.method === 'POST' ? { body: { ...body, app: { client_id: 'another-app' } } } : null })
  await assert.rejects(f.api.setup({ ownerUserId }), { code: 'scoped_app_mismatch' })
  assert.equal(f.revoked.length, 0); assert.equal(f.saved.length, 0)
})

test('refuses ambiguous installation client_id to app_id mappings', async () => {
  const f = fixture({ appId: null, response: ({ path }) => path === '/user/installations' ? { body: { installations: [installation, { ...installation, id: 124, app_id: 789 }] } } : null })
  await assert.rejects(f.api.setup({ ownerUserId }), { code: 'app_discovery_ambiguous' })
  assert.equal(f.revoked.length, 0); assert.equal(f.saved.length, 0)
})

test('cleanup refuses changed fixture state before obtaining or revoking any token', async () => {
  const f = fixture(), { state } = await f.api.setup({ ownerUserId })
  await assert.rejects(f.api.cleanup({ ...state, userId: ownerUserId }), { code: 'invalid_state' })
  assert.equal(f.revoked.length, 0); assert.equal(f.disconnected.length, 0)
})

test('a replaced smoke connection is preserved while the old minted token is revoked', async () => {
  const f = fixture({ disconnectError: new Error('concurrent authorization replaced it') })
  const { cleanup } = await f.api.setup({ ownerUserId })
  await assert.rejects(cleanup(), error => {
    assert.equal(error.code, 'cleanup_incomplete'); assert.equal(error.details.revoked, true); assert.equal(error.details.disconnected, false)
    return true
  })
  assert.deepEqual(f.revoked, [SCOPED_TOKEN]); assert.equal(f.disconnected.length, 0)
})
