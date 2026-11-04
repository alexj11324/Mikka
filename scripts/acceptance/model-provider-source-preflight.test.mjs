import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CASES, ORIGIN } from './model-provider-fallback.mjs'
import { runSourcePreflight } from './model-provider-source-preflight.mjs'

const SHA = 'a'.repeat(40)
const OWNER = 'private-owner-identity'
const WS = '10000000-0000-4000-8000-000000000001'
const KEY = '10000000-0000-4000-8000-000000000002'
const CLAUDE = '10000000-0000-4000-8000-000000000003'
const CODEX = '10000000-0000-4000-8000-000000000004'
const EMAIL = 'test+mikka-smoke-diagnosis@example.invalid'
const env = () => ({ MIKKA_EXPECTED_DEPLOYMENT_SHA: SHA, SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: 'private-password' })

function inventory() {
  const candidates = CASES.map((item, index) => ({ model: item.model, harness: item.harness,
    source: item.kind === 'api_key' ? { kind: 'api_key', keyId: KEY }
      : { kind: 'subscription', connectionId: index === 1 ? CLAUDE : CODEX },
    credentialOwnerId: OWNER, name: 'private-catalog-label' }))
  return { order: { candidates, entries: candidates, location: 'cloud', cloudReady: true },
    keys: { keys: [{ id: KEY, provider: 'deepseek', name: 'private-key-label', last4: 'priv' }] },
    connections: { connections: [{ id: CLAUDE, provider: 'claude', state: 'connected', paused: false, account: 'private-account-label' },
      { id: CODEX, provider: 'codex', state: 'connected', paused: false }] } }
}

function fixture({ workspaces = [WS], email = EMAIL, sessionEmail = email, sessionOwner = OWNER,
  botOwner = OWNER, versions = [SHA], stateFor = () => inventory(), failPath, logoutStatus = 200 } = {}) {
  const calls = []
  let versionReads = 0
  return { calls, fetchImpl: async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET'
    calls.push({ path: url.pathname, method, workspace: url.searchParams.get('workspace') })
    assert.equal(url.origin, ORIGIN)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.origin, ORIGIN)
    if (url.pathname === '/mikka/api/version') {
      assert.equal(method, 'GET')
      return Response.json({ build: versions[Math.min(versionReads++, versions.length - 1)] })
    }
    if (url.pathname === '/mikka/api/auth/sign-in/email') {
      assert.equal(method, 'POST')
      assert.deepEqual(JSON.parse(init.body), { email, password: 'private-password' })
      return new Response('{}', { status: 200, headers: { 'set-cookie': 'session=private-cookie; Secure; HttpOnly' } })
    }
    if (url.pathname === '/mikka/api/auth/sign-out') {
      assert.equal(method, 'POST')
      return Response.json({ success: logoutStatus === 200 }, { status: logoutStatus })
    }
    assert.equal(method, 'GET', 'source diagnosis permits no application writes')
    assert.equal(init.headers.cookie, 'session=private-cookie')
    if (url.pathname === '/mikka/api/auth/get-session') return Response.json({ user: { id: sessionOwner, email: sessionEmail } })
    if (url.pathname === '/mikka/api/bots') return Response.json(workspaces.map(workspaceId => ({ ownerId: botOwner, workspaceId, name: 'private-bot-label' })))
    if (url.pathname === failPath) return Response.json({ error: 'private-upstream-refusal', body: 'private-upstream-body' }, { status: 403 })
    const workspace = url.searchParams.get('workspace')
    assert.ok(workspaces.includes(workspace))
    const state = stateFor(workspace)
    if (url.pathname === '/mikka/api/settings/model-order') return Response.json(state.order)
    if (url.pathname === '/mikka/api/settings/api-keys') return Response.json(state.keys)
    if (url.pathname === '/mikka/api/subscriptions') return Response.json(state.connections)
    assert.fail('Unexpected endpoint; diagnosis must never call a model, create a fixture or change configuration')
  } }
}

function assertOnlyAuthenticationWrites(calls) {
  assert.deepEqual(calls.filter(call => call.method !== 'GET').map(call => call.path),
    ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
}

test('ordinary owner reads expose only layered source counts and provider state aggregates', async () => {
  const input = fixture()
  const report = await runSourcePreflight({ env: env(), fetchImpl: input.fetchImpl })
  assert.equal(report.status, 'observed')
  assert.equal(report.purpose, 'source_preflight')
  assert.equal(report.not_called_models, true)
  assert.equal(report.not_created_fixtures, true)
  assert.equal(report.ownerVerified, true)
  assert.equal(report.workspaceScope, 'current_default_workspace_own_bots')
  assert.equal(report.ownedWorkspaceCount, 1)
  assert.deepEqual(report.versionPin, { start: true, end: true })
  assert.equal(report.sessionClosed, true)
  assert.equal(report.workspaces[0].ordinal, 1)
  assert.deepEqual(report.workspaces[0].cases.map(row => row.counts), CASES.map(() => ({
    exactModel: 1, harnessAndKind: 1, ownSourceId: 1, credentialOwnerMatch: 1,
  })))
  assert.equal(report.workspaces[0].ownApiKeys.deepseek, 1)
  assert.equal(report.workspaces[0].ownSubscriptions.claude.connectedUnpaused, 1)
  assert.equal(report.workspaces[0].ownSubscriptions.codex.states.connected, 1)
  assertOnlyAuthenticationWrites(input.calls)
  const output = JSON.stringify(report)
  for (const value of [OWNER, WS, KEY, CLAUDE, CODEX, EMAIL, 'private-password', 'private-cookie',
    'private-catalog-label', 'private-account-label', 'private-bot-label', 'private-key-label']) assert.ok(!output.includes(value))
})

test('counts distinguish a model alias, a connection mismatch, and an owner mismatch without borrowing a source', async () => {
  const state = inventory()
  state.order.candidates[0].model = 'deepseek-v4.1-flash'
  state.order.candidates[1].credentialOwnerId = 'private-shared-owner'
  state.order.candidates[2].source.connectionId = KEY
  const input = fixture({ stateFor: () => state })
  const report = await runSourcePreflight({ env: env(), fetchImpl: input.fetchImpl })
  assert.deepEqual(report.workspaces[0].cases.map(row => row.counts), [
    { exactModel: 0, harnessAndKind: 0, ownSourceId: 0, credentialOwnerMatch: 0 },
    { exactModel: 1, harnessAndKind: 1, ownSourceId: 1, credentialOwnerMatch: 0 },
    { exactModel: 1, harnessAndKind: 1, ownSourceId: 0, credentialOwnerMatch: 0 },
  ])
  assert.equal(report.workspaces[0].cases[0].offeredForHarnessAndKind, 1)
  assert.equal(report.workspaces[0].cases[0].ownSourcePool, 1)
  assert.ok(!JSON.stringify(report).includes('private-shared-owner'))
  assertOnlyAuthenticationWrites(input.calls)
})

test('connection status projection never prints an unknown upstream state', async () => {
  const state = inventory()
  state.connections.connections[0].state = 'pending'
  state.connections.connections[1].state = 'private-upstream-error'
  state.connections.connections[1].paused = true
  const input = fixture({ stateFor: () => state })
  const report = await runSourcePreflight({ env: env(), fetchImpl: input.fetchImpl })
  const projected = report.workspaces[0]
  assert.equal(projected.ownSubscriptions.claude.states.pending, 1)
  assert.equal(projected.ownSubscriptions.codex.states.other, 1)
  assert.equal(projected.ownSubscriptions.codex.paused, 1)
  assert.deepEqual(projected.cases.map(row => row.ownSourcePool), [1, 0, 0])
  assert.ok(!JSON.stringify(report).includes('private-upstream-error'))
})

test('each discovered own workspace is read separately, without picking one for paid work', async () => {
  const workspaces = [WS, '10000000-0000-4000-8000-000000000005']
  const input = fixture({ workspaces })
  const report = await runSourcePreflight({ env: env(), fetchImpl: input.fetchImpl })
  assert.equal(report.ownedWorkspaceCount, 2)
  assert.deepEqual(report.workspaces.map(row => [row.ordinal, row.ownerMatched, row.status]), [[1, true, 'observed'], [2, true, 'observed']])
  for (const workspace of workspaces) assert.equal(input.calls.filter(call => call.workspace === workspace).length, 3)
  assertOnlyAuthenticationWrites(input.calls)
  assert.ok(workspaces.every(id => !JSON.stringify(report).includes(id)))
})

test('more than ten own workspaces is reported as ambiguous without reading any source inventory', async () => {
  const workspaces = Array.from({ length: 11 }, (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
  const input = fixture({ workspaces })
  const report = await runSourcePreflight({ env: env(), fetchImpl: input.fetchImpl })
  assert.equal(report.status, 'ambiguous')
  assert.equal(report.ownedWorkspaceCount, 11)
  assert.equal(report.code, 'workspace_limit')
  assert.deepEqual(report.workspaces, [])
  assert.ok(!input.calls.some(call => call.workspace))
  assertOnlyAuthenticationWrites(input.calls)
})

test('only the explicit documented test-vault marker admits caller-injected non-smoke test credentials', async () => {
  const email = 'dedicated-vault@example.invalid'
  const input = fixture({ email })
  const report = await runSourcePreflight({ env: { MIKKA_EXPECTED_DEPLOYMENT_SHA: SHA,
    MIKKA_SOURCE_PREFLIGHT_SOURCE: 'documented_test_vault', MIKKA_SOURCE_PREFLIGHT_EMAIL: email,
    MIKKA_SOURCE_PREFLIGHT_PASSWORD: 'private-password' }, fetchImpl: input.fetchImpl })
  assert.equal(report.status, 'observed')
  assert.equal(report.credentialSource, 'documented_test_vault')
  assert.ok(!JSON.stringify(report).includes(email))
  assertOnlyAuthenticationWrites(input.calls)
  for (const changed of [
    { SMOKE_OWNER_EMAIL: email }, { MIKKA_SOURCE_PREFLIGHT_SOURCE: 'any_account' },
    { MIKKA_ACCEPTANCE_BASE_URL: 'https://elsewhere.invalid/mikka' }, { MIKKA_EXPECTED_DEPLOYMENT_SHA: 'main' },
  ]) {
    let requests = 0
    await assert.rejects(runSourcePreflight({ env: { ...env(), ...changed }, fetchImpl: () => { requests++; assert.fail('Must not request') } }))
    assert.equal(requests, 0)
  }
})

test('a different session email, missing identity, or another owner bot blocks all inventory reads and logs out', async () => {
  for (const changed of [{ sessionEmail: 'other@example.invalid' }, { sessionOwner: '' }, { botOwner: 'another-owner' }]) {
    const input = fixture(changed)
    const report = await runSourcePreflight({ env: env(), fetchImpl: input.fetchImpl })
    assert.equal(report.status, 'blocked')
    assert.ok(['session_identity', 'workspace_missing'].includes(report.code))
    assert.deepEqual(report.workspaces, [])
    assert.ok(!input.calls.some(call => call.workspace))
    assert.equal(report.sessionClosed, true)
    assertOnlyAuthenticationWrites(input.calls)
  }
})

test('HTTP refusals remain sanitized and the authenticated session is always closed', async () => {
  const input = fixture({ failPath: '/mikka/api/settings/api-keys' })
  const report = await runSourcePreflight({ env: env(), fetchImpl: input.fetchImpl })
  assert.equal(report.status, 'partial')
  assert.equal(report.workspaces[0].code, 'http_refused')
  assert.equal(report.workspaces[0].httpStatus, 403)
  assert.equal(report.sessionClosed, true)
  assert.ok(!JSON.stringify(report).includes('private-upstream'))
  assertOnlyAuthenticationWrites(input.calls)
})

test('malformed owner-source identifiers cannot become a positive own-source match', async () => {
  const state = inventory()
  delete state.keys.keys[0].id
  delete state.order.candidates[0].source.keyId
  const input = fixture({ stateFor: () => state })
  const report = await runSourcePreflight({ env: env(), fetchImpl: input.fetchImpl })
  assert.equal(report.status, 'partial')
  assert.equal(report.workspaces[0].code, 'response_invalid')
  assert.equal(report.workspaces[0].cases, undefined)
  assert.equal(report.sessionClosed, true)
  assertOnlyAuthenticationWrites(input.calls)
})

test('the fixed production revision is checked before login and again before logout', async () => {
  const before = fixture({ versions: ['b'.repeat(40)] })
  const refused = await runSourcePreflight({ env: env(), fetchImpl: before.fetchImpl })
  assert.equal(refused.code, 'build_mismatch')
  assert.ok(before.calls.every(call => call.method === 'GET'))
  const after = fixture({ versions: [SHA, 'b'.repeat(40)] })
  const report = await runSourcePreflight({ env: env(), fetchImpl: after.fetchImpl })
  assert.equal(report.status, 'blocked')
  assert.equal(report.code, 'build_mismatch')
  assert.deepEqual(report.versionPin, { start: true, end: false })
  assert.equal(report.sessionClosed, true)
  assertOnlyAuthenticationWrites(after.calls)
})

test('failure to close the diagnostic session is reported instead of calling the read complete', async () => {
  const input = fixture({ logoutStatus: 503 })
  const report = await runSourcePreflight({ env: env(), fetchImpl: input.fetchImpl })
  assert.equal(report.status, 'failed')
  assert.equal(report.code, 'cleanup_incomplete')
  assert.equal(report.sessionClosed, false)
  assertOnlyAuthenticationWrites(input.calls)
})
