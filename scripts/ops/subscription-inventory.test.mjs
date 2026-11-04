import assert from 'node:assert/strict'
import test from 'node:test'
import { TARGET, projectMenu, runInventory } from './subscription-inventory.mjs'

// These contracts inject a deterministic transport. No provider or application I/O.
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const OWNER = id(900)
const EMAIL = 'inventory+mikka-smoke@example.test'
const PASSWORD = 'offline-inventory-password-12345'
const COOKIE = 'offline-inventory-cookie-12345'
const SESSION = 'offline-inventory-session-12345'
const env = {
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
  GITHUB_REF: 'refs/heads/acceptance/proactive-1157-1163', GITHUB_EVENT_NAME: 'push',
  SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: PASSWORD,
}
const verifySource = async () => ({ revision: TARGET.revision,
  isSmokeAccountEmail: value => typeof value === 'string' && /^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(value) })
const menu = () => ({ groups: [], current: {
  id: id(901), kind: 'subscription', provider: 'claude', modelId: 'claude-sonnet-4-6',
  available: true, availability: 'available', credentialLabel: EMAIL, owner: 'private owner',
  url: 'https://private.example.test', quota: { secret: PASSWORD },
} })
const defaultBots = [{ id: id(101), workspaceId: id(1), ownerId: OWNER, name: 'private bot' }]

function harness({ bots = defaultBots, model = menu(), foreignSession = false, failModel = false,
  driftBefore = false, driftAfter = false, failLogout = false } = {}) {
  const calls = []
  let versionCount = 0
  const fetchImpl = async (input, init) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://app.aspectlylabs.com')
    assert.equal(init.redirect, 'error')
    calls.push({ method: init.method, path: url.pathname + url.search, cookie: Boolean(init.headers.cookie) })
    if (url.pathname === '/mikka/api/version') {
      assert.equal(init.method, 'GET'); assert.equal(init.headers.cookie, undefined)
      const drift = versionCount++ === 0 ? driftBefore : driftAfter
      return Response.json({ build: drift ? 'dpl_DifferentDeployment' : TARGET.deployment, mobileUpdateUrl: 'https://private.example.test' })
    }
    if (url.pathname === '/mikka/api/auth/sign-in/email') {
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), { email: EMAIL, password: PASSWORD })
      return Response.json({ ignored: true }, { headers: { 'set-cookie': `better-auth.session_token=${COOKIE}; Path=/; HttpOnly; Secure` } })
    }
    assert.ok(init.headers.cookie?.includes(COOKIE))
    if (url.pathname === '/mikka/api/auth/get-session') {
      assert.equal(init.method, 'GET')
      return Response.json({ user: { id: OWNER, email: foreignSession ? 'foreign@example.test' : EMAIL }, session: { userId: OWNER, token: SESSION } })
    }
    if (url.pathname === '/mikka/api/bots') { assert.equal(init.method, 'GET'); return Response.json(bots) }
    if (url.pathname === '/mikka/api/mobile/model') {
      assert.equal(init.method, 'GET'); assert.equal([...url.searchParams.keys()].join(','), 'bot')
      if (failModel) throw new Error(`untrusted body ${PASSWORD} ${SESSION}`)
      return Response.json(model)
    }
    if (url.pathname === '/mikka/api/auth/sign-out') {
      assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), {})
      return Response.json({ success: !failLogout })
    }
    throw new Error('unexpected endpoint')
  }
  return { calls, fetchImpl }
}
const execute = (fixture, overrides = {}) => runInventory({ env, verifySource, fetchImpl: fixture.fetchImpl, now: () => '2026-11-04T00:00:00.000Z', ...overrides })

test('wrong execution/source/account scope fails before any request', async () => {
  for (const changes of [
    { GITHUB_ACTIONS: '' }, { GITHUB_REPOSITORY: 'someone/else' }, { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { SMOKE_OWNER_EMAIL: '' },
    { SMOKE_OWNER_EMAIL: 'ordinary@example.test' }, { SMOKE_OWNER_PASSWORD: '' },
  ]) {
    const fixture = harness()
    await assert.rejects(execute(fixture, { env: { ...env, ...changes } }), /inventory_(execution_scope|smoke_account_required)/)
    assert.equal(fixture.calls.length, 0)
  }
  const fixture = harness()
  await assert.rejects(execute(fixture, { verifySource: async () => ({ ...(await verifySource()), revision: '0'.repeat(40) }) }), /inventory_source_revision/)
  assert.equal(fixture.calls.length, 0)
})

test('deployment mismatch prevents login and any authenticated request', async () => {
  const fixture = harness({ driftBefore: true })
  const result = await execute(fixture)
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.errors, ['inventory_deployment_mismatch'])
  assert.deepEqual(fixture.calls, [{ method: 'GET', path: '/mikka/api/version', cookie: false }])
})

test('success reads one owned Bot per workspace, caps scopes at ten, and preserves pooled current', async () => {
  const bots = Array.from({ length: 12 }, (_, index) => ({ id: id(index + 101), workspaceId: id(index + 1), ownerId: OWNER }))
  bots.splice(1, 0, { id: id(777), workspaceId: id(1), ownerId: OWNER })
  const fixture = harness({ bots })
  const result = await execute(fixture)
  assert.equal(result.status, 'passed')
  assert.deepEqual(result.coverage, { scopeBoundary: 'current-session-visible-owned-bots', scopesSeen: 12, scopesRead: 10, limit: 10, truncated: true })
  assert.ok(result.scopes.every(scope => scope.subscriptionOptions.length === 0 && scope.current.kind === 'subscription' && scope.current.available))
  assert.equal(fixture.calls.filter(call => call.path.startsWith('/mikka/api/mobile/model?')).length, 10)
  assert.deepEqual(fixture.calls.filter(call => call.method !== 'GET').map(call => call.path), ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  assert.equal(result.authentication.sessionEnded, true)
  assert.equal(result.versionBefore, TARGET.deployment); assert.equal(result.versionAfter, TARGET.deployment)
  for (const forbidden of [EMAIL, PASSWORD, COOKIE, SESSION, 'private', 'credentialLabel', 'url', 'quota', 'https://']) assert.equal(JSON.stringify(result).includes(forbidden), false)
})

test('foreign session or Bot owner is rejected before menu reads and normal logout still runs', async () => {
  for (const config of [{ foreignSession: true }, { bots: [{ ...defaultBots[0], ownerId: id(999) }] }]) {
    const fixture = harness(config)
    const result = await execute(fixture)
    assert.equal(result.status, 'failed')
    assert.ok(result.errors.some(code => ['inventory_session_identity', 'inventory_bot_scope'].includes(code)))
    assert.equal(fixture.calls.some(call => call.path.startsWith('/mikka/api/mobile/model')), false)
    assert.equal(result.authentication.sessionEnded, true)
    assert.equal(result.versionAfter, TARGET.deployment)
  }
})

test('unknown request outcome is not retried and cannot leak its body or skip logout', async () => {
  const fixture = harness({ failModel: true })
  const result = await execute(fixture)
  assert.equal(result.status, 'failed'); assert.deepEqual(result.errors, ['inventory_model_request'])
  assert.equal(fixture.calls.filter(call => call.path.startsWith('/mikka/api/mobile/model')).length, 1)
  assert.equal(result.authentication.sessionEnded, true)
  assert.equal(result.versionAfter, TARGET.deployment)
  assert.equal(JSON.stringify(result).includes(PASSWORD), false)
  assert.equal(JSON.stringify(result).includes(SESSION), false)
})

test('post-read drift or unconfirmed logout fails; projection emits only approved public fields', async () => {
  for (const config of [{ driftAfter: true }, { failLogout: true }]) {
    const fixture = harness(config)
    const result = await execute(fixture)
    assert.equal(result.status, 'failed')
    assert.ok(result.errors.includes(config.driftAfter ? 'inventory_deployment_mismatch' : 'inventory_signout_unconfirmed'))
  }
  const input = menu()
  input.groups = [{ kind: 'subscription', owner: EMAIL, credentialLabel: PASSWORD, options: [
    { id: id(902), provider: 'codex', modelId: 'gpt-5-codex', private: COOKIE },
  ] }]
  assert.deepEqual(projectMenu(input), {
    subscriptionOptions: [{ id: id(902), provider: 'codex', modelId: 'gpt-5-codex' }],
    current: { kind: 'subscription', provider: 'claude', modelId: 'claude-sonnet-4-6', available: true, availability: 'available' },
  })
  input.current.modelId = PASSWORD
  assert.throws(() => projectMenu(input, new Set([PASSWORD])), /inventory_output_rejected/)
})
