import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { TARGET, GET_ROUTES, validateExecution, githubOidcUrl, oidcUrlShape, login, metadataClient, permissionEvidence,
  projectMetadata, inspect } from './infisical-cloud-capabilities.mjs'

const code = expected => error => error.code === expected && error.message === expected
const head = 'a'.repeat(40)
const fixtureCredential = 'synthetic'.repeat(4)
const orgId = '11111111-1111-4111-8111-111111111111'
const connectionId = '22222222-2222-4222-8222-222222222222'
const execution = () => ({
  env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: TARGET.repository,
    GITHUB_REPOSITORY_ID: String(TARGET.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(TARGET.ownerId),
    GITHUB_REF: TARGET.ref, GITHUB_ACTOR: 'alexj11324', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head },
  event: { repository: { full_name: TARGET.repository, id: TARGET.repositoryId, owner: { id: TARGET.ownerId }, fork: false },
    ref: TARGET.ref, after: head, deleted: false, forced: false },
  head, parent: TARGET.base, changed: ['.github/workflows/infisical-cloud-capabilities.yml',
    'scripts/ops/infisical-cloud-capabilities.mjs', 'scripts/ops/infisical-cloud-capabilities.test.mjs'],
})
const oidcEnv = () => ({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/fixed/jobs/opaque-runner-path?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: fixtureCredential })
const connection = () => ({ id: connectionId, name: TARGET.connection, app: 'vercel', method: 'api-token',
  projectId: null, orgId, credentials: {}, description: 'untrusted-provider-text' })
const responses = () => ({
  identity_details: { identityDetails: { organization: { id: orgId, name: 'Aspectly Labs', slug: 'untrusted-provider-text' } } },
  project_membership: { identityMembership: { identity: { id: TARGET.identity, orgId },
    roles: [{ role: 'viewer', isTemporary: false, customRoleName: 'untrusted-provider-text' }] } },
  project_permission_audit: { sources: [{ type: 'role', slug: 'viewer', name: 'untrusted-provider-text',
    permissions: [['read', 'secret-syncs'], ['read-app-connections', 'app-connections']] }] },
  known_connection: { appConnection: connection() },
  available_org_connections: { appConnections: [{ id: connectionId, name: TARGET.connection, app: 'vercel', projectId: null, orgId }] },
  project_vercel_syncs: { secretSyncs: [{ projectId: TARGET.project, destination: 'vercel',
    connection: { id: connectionId, name: TARGET.connection }, destinationConfig: { scope: 'project', app: TARGET.privateVercelProject, env: 'production' },
    lastSyncMessage: 'untrusted-provider-text' }] },
})

test('execution is locked to the existing repository, reviewed ops parent and three owned files', () => {
  assert.equal(validateExecution(execution()).base, TARGET.base)
  for (const [key, value] of Object.entries({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'other/repo',
    GITHUB_REPOSITORY_ID: '1', GITHUB_REPOSITORY_OWNER_ID: '1', GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'other', GITHUB_RUN_ATTEMPT: '2' })) {
    const input = execution(); input.env[key] = value
    assert.throws(() => validateExecution(input), code('EXECUTION_SCOPE'))
  }
  const fork = execution(); fork.event.repository.fork = true
  assert.throws(() => validateExecution(fork), code('EVENT_SCOPE'))
  const forced = execution(); forced.event.forced = true
  assert.throws(() => validateExecution(forced), code('EVENT_SCOPE'))
  const parent = execution(); parent.parent = 'b'.repeat(40)
  assert.throws(() => validateExecution(parent), code('SOURCE_SCOPE'))
  const product = execution(); product.changed.push('lib/auth.ts')
  assert.throws(() => validateExecution(product), code('SOURCE_SCOPE'))
})

test('OIDC token request uses only the runner endpoint and the existing audience', () => {
  const url = new URL(githubOidcUrl(oidcEnv().ACTIONS_ID_TOKEN_REQUEST_URL))
  assert.equal(url.searchParams.get('audience'), TARGET.audience)
  assert.equal(url.searchParams.get('api-version'), '2.0')
  for (const value of ['http://pipelines.actions.githubusercontent.com/idtoken',
    'https://pipelines.actions.githubusercontent.com.invalid/idtoken', 'https://example.invalid/idtoken',
    'https://user@pipelines.actions.githubusercontent.com/idtoken', 'https://pipelines.actions.githubusercontent.com:8443/idtoken',
    'https://githubapp.com/idtoken', 'https://actions.githubusercontent.com.invalid/idtoken',
    'https://pipelines.actions.githubusercontent.com/idtoken#fragment']) {
    assert.throws(() => githubOidcUrl(value), code('OIDC_URL'))
  }
})

test('the trusted runner URL keeps its opaque path and query while fixing only the requested audience', () => {
  const supplied = 'https://pipelines.actions.githubusercontent.com/fixed/jobs/opaque-runner-path?api-version=2.0&audience=synthetic'
  assert.equal(oidcUrlShape(supplied).pathClass, 'OTHER')
  const url = new URL(githubOidcUrl(supplied))
  assert.equal(url.origin, 'https://pipelines.actions.githubusercontent.com')
  assert.equal(url.pathname, '/fixed/jobs/opaque-runner-path')
  assert.equal(url.searchParams.get('api-version'), '2.0')
  assert.deepEqual(url.searchParams.getAll('audience'), [TARGET.audience])
  assert.throws(() => githubOidcUrl(supplied.replace('pipelines.actions.githubusercontent.com', 'runner.invalid')), code('OIDC_URL'))
})

test('normal login exchanges only GitHub OIDC for the fixed existing identity, with no token in receipts', async () => {
  const calls = [], requests = []
  const value = await login(oidcEnv(), requests, async (url, options) => {
    calls.push({ url, method: options.method })
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    if (calls.length === 1) return Response.json({ value: fixtureCredential })
    assert.equal(url, 'https://app.infisical.com/api/v1/auth/oidc-auth/login')
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { identityId: TARGET.identity, jwt: fixtureCredential })
    return Response.json({ accessToken: fixtureCredential, tokenType: 'Bearer', expiresIn: 900 })
  })
  assert.equal(value, fixtureCredential)
  assert.equal(calls.length, 2)
  assert.deepEqual(requests, [{ operation: 'github_oidc', status: 200 }, { operation: 'identity_oidc_login', status: 200 }])
  assert.equal(JSON.stringify(requests).includes(fixtureCredential), false)
})

test('denied login never reads error content or attempts an alternative identity', async () => {
  const requests = []; let calls = 0; let canceled = false
  await assert.rejects(login(oidcEnv(), requests, async () => {
    calls++
    return { status: 403, body: { cancel: async () => { canceled = true } }, json: () => assert.fail('error body must not be read') }
  }), code('OIDC_LOGIN'))
  assert.equal(calls, 1)
  assert.equal(canceled, true)
})

test('metadata transport permits only the six fixed GETs and never follows redirects', async () => {
  const calls = [], requests = []
  const client = metadataClient(fixtureCredential, requests, async (url, options) => {
    calls.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.body, undefined)
    assert.equal(options.headers.authorization, `Bearer ${fixtureCredential}`)
    return Response.json({})
  })
  for (const operation of Object.keys(GET_ROUTES)) await client(operation)
  assert.deepEqual(calls, Object.values(GET_ROUTES).map(path => `https://app.infisical.com${path}`))
  for (const invalid of ['secrets', '/api/v3/secrets/raw', 'create_sync', 'rotate_credentials', 'constructor', '__proto__']) {
    assert.throws(() => client(invalid), code('API_ROUTE'))
  }
  assert.equal(calls.length, 6)
})

test('rule evidence distinguishes absent grants, conditional grants and denies without pretending to evaluate CASL', () => {
  const evidence = permissionEvidence({ sources: [{ type: 'role', slug: 'custom', permissions: [
    ['read', 'secret-syncs'], ['create,edit', 'secret-syncs', { environment: 'prod', secretPath: '/vercel' }],
    ['edit', 'secret-syncs', 0, 1], ['create', 'secrets', 0, 0, 'name'],
  ] }] })
  const create = evidence.capabilities.find(row => row.subject === 'secret-syncs' && row.action === 'create')
  assert.equal(create.grantRules, 1)
  assert.equal(create.conditionalGrantRules, 1)
  assert.equal(create.grantAbsent, false)
  const edit = evidence.capabilities.find(row => row.subject === 'secret-syncs' && row.action === 'edit')
  assert.equal(edit.denyRules, 1)
  assert.equal(evidence.capabilities.find(row => row.action === 'sync-secrets').grantAbsent, true)
  const malformed = permissionEvidence({ sources: [{ type: 'role', slug: 'viewer', permissions: [{ action: 'create' }] }] })
  assert.equal(malformed.unknownRuleCount, 1)
  assert.ok(malformed.capabilities.every(row => row.grantAbsent === false))
  const admin = permissionEvidence({ sources: [{ type: 'role', slug: 'admin', permissions: [['manage', 'all']] }] })
  assert.ok(admin.capabilities.every(row => row.grantRules === 1 && row.grantAbsent === false))
})

test('the six endpoint projections expose only the requested closed capability evidence', async () => {
  const fixture = responses(), called = []
  const result = await inspect(async operation => {
    called.push(operation)
    return { status: 200, outcome: 'readable', data: fixture[operation] }
  })
  assert.deepEqual(called, Object.keys(GET_ROUTES))
  assert.deepEqual(result.project_membership.metadata.roles, [{ role: 'viewer', temporary: false }])
  assert.equal(result.known_connection.metadata.credentialsEmpty, true)
  assert.equal(result.available_org_connections.metadata.targetAvailableForConnect, true)
  assert.equal(result.project_vercel_syncs.metadata.privateProductionSyncCount, 1)
  assert.equal(result.project_vercel_syncs.metadata.teamScopeSyncCount, 0)
  assert.equal(JSON.stringify(result).includes('untrusted-provider-text'), false)
  assert.equal(JSON.stringify(result).includes(fixtureCredential), false)
})

test('metadata denial stays a closed HTTP result and does not hide independent available-connection evidence', async () => {
  const fixture = responses()
  const result = await inspect(async operation => operation === 'known_connection'
    ? { status: 403, outcome: 'denied' } : { status: 200, outcome: 'readable', data: fixture[operation] })
  assert.deepEqual(result.known_connection, { status: 403, outcome: 'denied' })
  assert.equal(result.available_org_connections.metadata.targetAvailableForConnect, true)
  assert.equal(result.available_org_connections.metadata.connectionIdMatches, null)
})

test('unexpected credential fields or wrong identity/project cannot become a successful metadata proof', () => {
  const unexpected = connection(); unexpected.credentials = { apiToken: fixtureCredential }
  assert.throws(() => projectMetadata('known_connection', { appConnection: unexpected }, {}), code('CONNECTION_NOT_SANITIZED'))
  assert.throws(() => projectMetadata('project_membership', { identityMembership: { identity: { id: 'other' }, roles: [] } }, {}), code('MEMBERSHIP_SCHEMA'))
  assert.throws(() => projectMetadata('project_vercel_syncs', { secretSyncs: [{ projectId: 'other', destination: 'vercel' }] }, {}), code('SYNC_SCOPE'))
})

test('no CLI mode can perform a configuration write', () => {
  const child = spawnSync(process.execPath, [new URL('./infisical-cloud-capabilities.mjs', import.meta.url).pathname, '--apply'], {
    encoding: 'utf8', env: { PATH: process.env.PATH },
  })
  assert.equal(child.status, 1)
  const receipt = JSON.parse(child.stdout.trim())
  assert.equal(receipt.error, 'MODE')
  assert.equal(receipt.configurationWrites, 0)
  assert.deepEqual(receipt.requests, [])
})

test('URL-shape diagnostics use only closed categories and do not permit untrusted runner origins', () => {
  const valid = oidcUrlShape('https://pipelines.actions.githubusercontent.com/fixed/idtoken?api-version=2.0')
  assert.equal(valid.scheme, 'https')
  assert.equal(valid.hostActionsGithubusercontent, true)
  assert.equal(valid.pathClass, 'idtoken')
  assert.equal(valid.userinfoPresent, false)
  const alternate = 'https://user:synthetic@worker.githubapp.com:8443/opaque/oidc-token/?opaque=untrusted-provider-text#opaque'
  const shape = oidcUrlShape(alternate)
  assert.equal(shape.hostGithubAppCom, true)
  assert.equal(shape.hostActionsGithubusercontent, false)
  assert.equal(shape.pathClass, 'oidc-token')
  assert.equal(shape.pathTrailingSlash, true)
  assert.equal(shape.portPresent, true)
  assert.equal(shape.userinfoPresent, true)
  assert.equal(shape.fragmentPresent, true)
  for (const value of [undefined, 'untrusted-provider-text', alternate,
    'http://127.0.0.1/untrusted-provider-text?opaque=untrusted-provider-text',
    'https://untrusted-provider-text.invalid/untrusted-provider-text', 'data:text/plain,untrusted-provider-text']) {
    const result = oidcUrlShape(value)
    assert.ok(Object.values(result).every(item => typeof item === 'boolean' ||
      ['https', 'http', 'OTHER', 'idtoken', 'id-token', 'oidctoken', 'oidc-token', 'oidc', 'token'].includes(item)))
    assert.equal(JSON.stringify(result).includes('untrusted-provider-text'), false)
    assert.equal(JSON.stringify(result).includes('synthetic'), false)
  }
  assert.throws(() => githubOidcUrl(alternate), code('OIDC_URL'))
})

// Fresh rollout readback, 2026-11-07.
