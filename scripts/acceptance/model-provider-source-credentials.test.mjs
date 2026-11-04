import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCredentialSourcePreflight } from './model-provider-source-credentials.mjs'

const SHA = 'a'.repeat(40)
const PROJECT = '89850d6a-f020-4936-863e-df77380dfe40'
const VAULT = '10000000-0000-4000-8000-000000000001'
const INFISICAL = 'https://app.infisical.com'
const EMAIL = 'test+mikka-smoke-preflight@example.invalid'
const VAULT_EMAIL = 'dedicated-vault@example.invalid'
const env = () => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
  GITHUB_REF: 'refs/heads/fix/1225-source-preflight', MIKKA_EXPECTED_DEPLOYMENT_SHA: SHA,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/token?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-request-token' })
const secrets = { SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: 'private-smoke-password',
  MIKKA_TEST_ACCOUNT_EMAIL: VAULT_EMAIL, MIKKA_TEST_ACCOUNT_PASSWORD: 'private-vault-password' }
const cases = [
  ['deepseek_402_fallback', 'deepseek-flash'],
  ['official_claude', 'claude-haiku-5-5'],
  ['official_codex', 'gpt-6-luna'],
]
function helperReport(input) {
  const subscription = () => ({ total: 1, paused: 0, connectedUnpaused: 1,
    states: { pending: 0, connected: 1, reconnect_required: 0, disconnected: 0, other: 0 } })
  return { issue: 1225, purpose: 'source_preflight', credentialSource: input.MIKKA_SOURCE_PREFLIGHT_SOURCE,
    revision: SHA, status: 'observed', not_called_models: true, not_created_fixtures: true,
    workspaceScope: 'current_default_workspace_own_bots', ownerVerified: true,
    ownedWorkspaceCount: 1, workspaceLimit: 10, versionPin: { start: true, end: true }, sessionClosed: true,
    workspaces: [{ ordinal: 1, ownerMatched: true, status: 'observed', candidateCount: 3, orderEntryCount: 3,
      candidateOwnerFieldPresent: 3, candidateOwnerMatched: 3, location: 'cloud', cloudReady: true,
      ownApiKeys: { total: 1, deepseek: 1 }, ownSubscriptions: { claude: subscription(), codex: subscription() },
      cases: cases.map(([id, model]) => ({ case: id, model, ownSourcePool: 1, offeredForHarnessAndKind: 1,
        counts: { exactModel: 1, harnessAndKind: 1, ownSourceId: 1, credentialOwnerMatch: 1 } })) }] }
}
function fixture({ projects = [{ id: VAULT, name: 'Mikka Test Account Vault' }], response, helper } = {}) {
  const calls = [], helperInputs = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    calls.push({ url, init })
    assert.equal(init.redirect, 'error')
    if (response) {
      const override = await response(url, init)
      if (override) return override
    }
    if (url.origin === 'https://token.actions.githubusercontent.com') {
      assert.equal(init.method, 'GET')
      assert.equal(url.searchParams.get('audience'), 'mikka-infisical')
      assert.equal(url.searchParams.get('api-version'), '2.0')
      assert.equal(init.headers.authorization, 'Bearer private-request-token')
      return Response.json({ value: 'private-oidc-jwt' })
    }
    assert.equal(url.origin, INFISICAL)
    if (url.pathname === '/api/v1/auth/oidc-auth/login') {
      assert.equal(init.method, 'POST')
      assert.equal(init.headers.authorization, undefined)
      assert.deepEqual(JSON.parse(init.body), {
        identityId: '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', jwt: 'private-oidc-jwt',
      })
      return Response.json({ accessToken: 'private-infisical-token', tokenType: 'Bearer', expiresIn: 7200 })
    }
    assert.equal(init.method, 'GET', 'no identity or permission mutations')
    assert.equal(init.headers.authorization, 'Bearer private-infisical-token')
    if (url.pathname === '/api/v1/projects') {
      assert.equal(url.searchParams.get('includeRoles'), 'false')
      return Response.json({ projects })
    }
    assert.ok(url.pathname.startsWith('/api/v4/secrets/'))
    const name = url.pathname.split('/').at(-1)
    assert.ok(Object.hasOwn(secrets, name), 'only the four authorized secret names may be read')
    const smoke = name.startsWith('SMOKE_')
    assert.equal(url.searchParams.get('projectId'), smoke ? PROJECT : VAULT)
    assert.equal(url.searchParams.get('environment'), smoke ? 'prod' : 'dev')
    assert.equal(url.searchParams.get('secretPath'), smoke ? '/' : '/test-account')
    assert.equal(url.searchParams.get('type'), 'shared')
    assert.equal(url.searchParams.get('includeImports'), 'false')
    assert.equal(url.searchParams.get('expandSecretReferences'), 'false')
    assert.equal(url.searchParams.get('viewSecretValue'), 'true')
    return Response.json({ secret: { secretKey: name, secretValue: secrets[name], secretValueHidden: false,
      workspace: smoke ? PROJECT : VAULT, environment: smoke ? 'prod' : 'dev',
      secretPath: smoke ? '/' : '/test-account', type: 'shared' } })
  }
  const sourcePreflight = async ({ env: input, fetchImpl: supplied }) => {
    assert.equal(supplied, fetchImpl)
    helperInputs.push(input)
    return helper ? helper(input) : helperReport(input)
  }
  return { calls, helperInputs, fetchImpl, sourcePreflight }
}
const run = (input, overrides = {}) => runCredentialSourcePreflight({
  env: { ...env(), ...overrides }, fetchImpl: input.fetchImpl, sourcePreflight: input.sourcePreflight,
})
function assertRedacted(report) {
  const output = JSON.stringify(report)
  for (const value of [...Object.values(secrets), 'private-request-token', 'private-oidc-jwt',
    'private-infisical-token', 'private-upstream-body', 'private-helper-error', 'private-owner', VAULT]) {
    assert.ok(!output.includes(value), 'report must not contain credential or upstream fields')
  }
}

test('only the exact GitHub repository, preflight branch and immutable application SHA may start', async () => {
  for (const changed of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'someone/Mikka' },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/pull/1249/merge' },
    { MIKKA_EXPECTED_DEPLOYMENT_SHA: 'main' }, { MIKKA_EXPECTED_DEPLOYMENT_SHA: 'A'.repeat(40) }]) {
    const input = fixture()
    const report = await run(input, changed)
    assert.equal(report.status, 'blocked')
    assert.ok(['scope_rejected', 'configuration_required'].includes(report.code))
    assert.equal(input.calls.length, 0)
    assert.equal(input.helperInputs.length, 0)
  }
})

test('GitHub request tokens never go to an arbitrary OIDC endpoint', async () => {
  for (const url of ['https://attacker.invalid/token', 'http://token.actions.githubusercontent.com/token',
    'https://token.actions.githubusercontent.com.attacker.invalid/token',
    'https://user:password@token.actions.githubusercontent.com/token']) {
    const input = fixture()
    const report = await run(input, { ACTIONS_ID_TOKEN_REQUEST_URL: url })
    assert.equal(report.code, 'oidc_unavailable')
    assert.equal(input.calls.length, 0)
  }
})

test('one existing OIDC identity supplies four exact secrets to two independent in-memory helper calls', async () => {
  const input = fixture(), original = env()
  const report = await runCredentialSourcePreflight({ env: original, fetchImpl: input.fetchImpl, sourcePreflight: input.sourcePreflight })
  assert.equal(report.status, 'observed')
  assert.equal(report.purpose, 'credential_source_preflight')
  assert.equal(report.revision, SHA)
  assert.deepEqual(report.sources.map(row => [row.source, row.status]),
    [['smoke', 'observed'], ['documented_test_vault', 'observed']])
  assert.deepEqual(input.helperInputs.map(row => row.MIKKA_SOURCE_PREFLIGHT_SOURCE), ['smoke', 'documented_test_vault'])
  assert.equal(input.helperInputs[0].SMOKE_OWNER_EMAIL, EMAIL)
  assert.equal(input.helperInputs[0].SMOKE_OWNER_PASSWORD, secrets.SMOKE_OWNER_PASSWORD)
  assert.equal(input.helperInputs[1].MIKKA_SOURCE_PREFLIGHT_EMAIL, VAULT_EMAIL)
  assert.equal(input.helperInputs[1].MIKKA_SOURCE_PREFLIGHT_PASSWORD, secrets.MIKKA_TEST_ACCOUNT_PASSWORD)
  assert.equal(original.SMOKE_OWNER_EMAIL, undefined, 'caller environment is not mutated')
  assert.equal(original.MIKKA_SOURCE_PREFLIGHT_PASSWORD, undefined)
  assert.equal(input.calls.filter(call => call.url.pathname.includes('/api/v4/secrets/')).length, 4)
  assert.equal(input.calls.filter(call => call.init.method === 'POST').length, 1)
  assert.equal(report.sources[1].preflight.workspaceScope, 'current_default_workspace_own_bots')
  assert.equal(report.sources[1].preflight.workspaces[0].candidateCount, 3)
  assertRedacted(report)
})

test('a smoke 403 does not prevent the documented Vault diagnosis', async () => {
  const input = fixture({ response: url => url.pathname.endsWith('/SMOKE_OWNER_EMAIL')
    ? Response.json({ message: 'private-upstream-body', secretValue: 'not-a-credential' }, { status: 403 }) : undefined })
  const report = await run(input)
  assert.equal(report.status, 'partial')
  assert.deepEqual(report.sources.map(row => row.status), ['blocked', 'observed'])
  assert.equal(report.sources[0].httpStatus, 403)
  assert.equal(report.sources[0].phase, 'smoke_email')
  assert.deepEqual(input.helperInputs.map(row => row.MIKKA_SOURCE_PREFLIGHT_SOURCE), ['documented_test_vault'])
  assertRedacted(report)
})

test('a Vault listing 403 preserves the smoke result without guessing another identity or project', async () => {
  const input = fixture({ response: url => url.pathname === '/api/v1/projects'
    ? Response.json({ message: 'private-upstream-body' }, { status: 403 }) : undefined })
  const report = await run(input)
  assert.equal(report.status, 'partial')
  assert.equal(report.sources[0].status, 'observed')
  assert.equal(report.sources[1].phase, 'vault_projects')
  assert.equal(report.sources[1].httpStatus, 403)
  assert.equal(input.helperInputs.length, 1)
  assertRedacted(report)
})

test('404 responses are refusals even if their body contains apparent values', async () => {
  const input = fixture({ response: url => ['/api/v4/secrets/SMOKE_OWNER_EMAIL', '/api/v4/secrets/MIKKA_TEST_ACCOUNT_EMAIL'].includes(url.pathname)
    ? Response.json({ secret: { secretValue: 'private-upstream-body' } }, { status: 404 }) : undefined })
  const report = await run(input)
  assert.equal(report.status, 'blocked')
  assert.deepEqual(report.sources.map(row => [row.code, row.httpStatus]), [['http_refused', 404], ['http_refused', 404]])
  assert.equal(input.helperInputs.length, 0)
  assertRedacted(report)
})

test('Vault project selection requires a unique exact name and never prints project inventory', async () => {
  for (const [projects, code] of [
    [[], 'vault_not_visible'],
    [[{ id: VAULT, name: 'Mikka Test Account Vault suffix' }], 'vault_not_visible'],
    [[{ id: VAULT, name: 'Mikka Test Account Vault' }, { id: 'another-private-id', name: 'Mikka Test Account Vault' }], 'vault_ambiguous'],
  ]) {
    const input = fixture({ projects })
    const report = await run(input)
    assert.equal(report.sources[1].code, code)
    assert.equal(input.calls.filter(call => call.url.pathname.includes('/MIKKA_TEST_ACCOUNT_')).length, 0)
    assert.equal(input.helperInputs.length, 1)
    assertRedacted(report)
  }
})

test('hidden, empty, wrong-key and wrong-scope secrets cannot become application credentials', async () => {
  for (const changed of [{ secretValueHidden: true }, { secretValue: '' }, { secretKey: 'OTHER_SECRET' },
    { workspace: PROJECT }, { environment: 'prod' }, { secretPath: '/' }, { type: 'personal' }]) {
    const input = fixture({ response: url => url.pathname.endsWith('/MIKKA_TEST_ACCOUNT_EMAIL')
      ? Response.json({ secret: { secretKey: 'MIKKA_TEST_ACCOUNT_EMAIL', secretValue: VAULT_EMAIL,
        secretValueHidden: false, workspace: VAULT, environment: 'dev', secretPath: '/test-account', type: 'shared', ...changed } }) : undefined })
    const report = await run(input)
    assert.equal(report.sources[1].status, 'blocked')
    assert.ok(['credential_hidden', 'credential_response_invalid'].includes(report.sources[1].code))
    assert.equal(input.helperInputs.length, 1)
    assertRedacted(report)
  }
})

test('malformed OIDC or login JSON produces safe failures for both sources before any secret reads', async () => {
  for (const path of ['/token', '/api/v1/auth/oidc-auth/login']) {
    const input = fixture({ response: url => url.pathname === path ? new Response('private-upstream-body') : undefined })
    const report = await run(input)
    assert.equal(report.status, 'blocked')
    assert.equal(report.sources.length, 2)
    assert.ok(report.sources.every(row => row.code === 'response_invalid'))
    assert.equal(input.calls.filter(call => call.url.pathname.includes('/secrets/')).length, 0)
    assertRedacted(report)
  }
})

test('an unknown helper exception is redacted and does not stop the other source', async () => {
  const input = fixture({ helper: input => {
    if (input.MIKKA_SOURCE_PREFLIGHT_SOURCE === 'smoke') throw new Error('private-helper-error ' + EMAIL)
    return helperReport(input)
  } })
  const report = await run(input)
  assert.equal(report.sources[0].status, 'failed')
  assert.equal(report.sources[0].code, 'source_preflight_failed')
  assert.equal(report.sources[1].status, 'observed')
  assertRedacted(report)
})

test('the wrapper projects only known helper counts, booleans, enums and fixed models', async () => {
  const input = fixture({ helper: input => {
    const report = helperReport(input)
    report.rawBody = 'private-upstream-body'
    report.ownerId = 'private-owner'
    report.workspaces[0].account = EMAIL
    report.workspaces[0].ownApiKeys.keyValue = 'private-infisical-token'
    report.workspaces[0].cases[0].sourceLabel = 'private-upstream-body'
    return report
  } })
  const report = await run(input)
  assert.equal(report.status, 'observed')
  assert.equal(report.sources[0].preflight.workspaces[0].cases[0].counts.exactModel, 1)
  assertRedacted(report)
})

test('helper HTTP failures retain only safe diagnostics and bounded workspace evidence', async () => {
  const input = fixture({ helper: input => ({ ...helperReport(input), status: 'partial',
    workspaces: [{ ordinal: 1, ownerMatched: true, status: 'blocked', code: 'http_refused', httpStatus: 403,
      serverCode: 'private-upstream-body', message: EMAIL }] }) })
  const report = await run(input)
  assert.equal(report.status, 'partial')
  assert.deepEqual(report.sources[0].preflight.workspaces[0],
    { ordinal: 1, ownerMatched: true, status: 'blocked', code: 'http_refused', httpStatus: 403 })
  assertRedacted(report)
})

test('a helper report bound to another revision or source is rejected without copying raw fields', async () => {
  for (const changed of [{ revision: 'b'.repeat(40) }, { credentialSource: 'someone_else' },
    { not_called_models: false }, { workspaceScope: 'all_workspaces' },
    { status: 'observed', sessionClosed: false }]) {
    const input = fixture({ helper: input => ({ ...helperReport(input), ...changed, secretValue: EMAIL }) })
    const report = await run(input)
    assert.ok(report.sources.every(row => row.status === 'failed' && row.code === 'helper_report_invalid'))
    assertRedacted(report)
  }
})
