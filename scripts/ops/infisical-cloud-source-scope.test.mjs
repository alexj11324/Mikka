import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { TARGET, LIMITS, validateExecution, githubOidcUrl, login, metadataClient, validateReadPermissions,
  projectSyncs, projectImports, projectSubfolders, newEvidence, inspect } from './infisical-cloud-source-scope.mjs'

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
  head, parent: TARGET.base, changed: ['.github/workflows/infisical-cloud-source-scope.yml',
    'scripts/ops/infisical-cloud-source-scope.mjs', 'scripts/ops/infisical-cloud-source-scope.test.mjs'],
})
const oidcEnv = () => ({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/fixed/jobs/opaque-runner-path?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: fixtureCredential })
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

const envIds = { prod: '33333333-3333-4333-8333-333333333333', staging: '44444444-4444-4444-8444-444444444444', dev: '55555555-5555-4555-8555-555555555555' }
const folderId = '66666666-6666-4666-8666-666666666666'
const rowId = '77777777-7777-4777-8777-777777777777'
const importId = '88888888-8888-4888-8888-888888888888'
const childId = '99999999-9999-4999-8999-999999999999'
const audit = () => ({ sources: [{ permissions: [['manage', 'all']], description: 'untrusted-provider-text' }] })
const sync = (overrides = {}) => ({ id: rowId, projectId: TARGET.project, destination: 'vercel',
  connection: { id: connectionId, app: 'vercel', name: TARGET.connection },
  environment: { id: envIds.prod, slug: 'prod', name: 'untrusted-provider-text' },
  folder: { id: folderId, path: '/vercel' }, isAutoSyncEnabled: true,
  syncOptions: { includeAllSubFolders: false }, destinationConfig: { scope: 'project', app: TARGET.publicVercelProject, env: 'production' },
  lastSyncMessage: 'untrusted-provider-text', ...overrides })
const imported = (path, environment = 'prod', overrides = {}) => ({ id: importId, folderId, importPath: path,
  importEnv: { id: envIds[environment], slug: environment, projectId: TARGET.project }, isReplication: false,
  sourceProjectName: 'untrusted-provider-text', ...overrides })
const requestFixture = ({ rows = [sync()], imports = {}, folders = {} } = {}) => {
  const calls = []
  return { calls, request: async (operation, scope) => {
    const key = scope ? scope.environment + ':' + scope.path : null
    calls.push([operation, key])
    if (operation === 'project_permissions') return { status: 200, data: audit() }
    if (operation === 'project_vercel_syncs') return { status: 200, data: { secretSyncs: rows } }
    if (operation === 'imports') return { status: 200, data: { secretImports: imports[key] ?? [] } }
    if (operation === 'subfolders') return { status: 200, data: { folders: folders[key] ?? [] } }
    assert.fail('Unexpected operation')
  } }
}

test('metadata transport is GET-only, project-fixed and excludes every secrets or mutation endpoint', async () => {
  const calls = [], requests = []
  const client = metadataClient(fixtureCredential, requests, async (url, options) => {
    calls.push(url)
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer ' + fixtureCredential)
    return Response.json({})
  })
  for (const operation of ['project_permissions', 'project_vercel_syncs', 'imports', 'subfolders']) {
    await client(operation, { environment: 'prod', path: '/vercel' })
  }
  assert.equal(calls.length, 4)
  assert.ok(calls.every(url => url.startsWith('https://app.infisical.com/api/') && url.includes(TARGET.project)))
  assert.ok(calls.every(url => !url.includes('/secrets/') && !url.includes('/secret-imports/secrets')))
  assert.equal(new URL(calls[3]).searchParams.get('recursive'), 'true')
  for (const invalid of ['create_folder', 'create_key', 'secrets', 'constructor', '__proto__', 'https://example.invalid']) {
    assert.throws(() => client(invalid), code('API_ROUTE'))
  }
  for (const scope of [{ environment: 'other', path: '/vercel' }, { environment: 'prod', path: '//vercel' },
    { environment: 'prod', path: '/vercel/../other' }, { environment: 'prod', path: '/vercel?secret=true' },
    { environment: 'prod', path: '/vercel%2fother' }]) {
    assert.throws(() => client('imports', scope), code('METADATA_SCOPE'))
  }
  assert.equal(calls.length, 4)
  assert.equal(JSON.stringify(requests).includes(fixtureCredential), false)
})

test('a complete-list claim requires current unrestricted project read grants', () => {
  assert.deepEqual(validateReadPermissions(audit()), { syncReadUnrestricted: true, importReadUnrestricted: true })
  for (const rules of [[], [['read', 'secret-syncs']], [['read', 'secret-syncs,secret-imports', { environment: 'prod' }]],
    [['manage', 'all', 0, 0, 'id']], [['manage', 'all'], ['read', 'secret-imports', 0, 1]]]) {
    assert.throws(() => validateReadPermissions({ sources: [{ permissions: rules }] }), code('PROJECT_READ_NOT_UNRESTRICTED'))
  }
  assert.throws(() => validateReadPermissions({ sources: [{ permissions: [{ action: 'manage' }] }] }), code('AUDIT_SCHEMA'))
})

test('existing source projections preserve relevant coverage while dropping provider messages', async () => {
  const fixture = requestFixture(), evidence = await inspect(fixture.request)
  assert.equal(evidence.sourceAndImportCoverage, 'not_covered'); assert.equal(evidence.canCreate, false)
  assert.equal(evidence.secretReferenceCoverage, 'not_inspected')
  assert.deepEqual(fixture.calls, [['project_permissions', null], ['project_vercel_syncs', null], ['imports', 'prod:/vercel']])
  assert.equal(evidence.syncs[0].effectiveIncludeImports, true)
  assert.equal(evidence.syncs[0].connectionId, connectionId)
  assert.equal(JSON.stringify(evidence).includes('untrusted-provider-text'), false)
  assert.equal(JSON.stringify(evidence).includes(fixtureCredential), false)
})

test('a recursive prod root or an exact source covers the proposed folder even with auto-sync off', async () => {
  for (const row of [sync({ folder: { id: folderId, path: '/' }, syncOptions: { includeAllSubFolders: true }, isAutoSyncEnabled: false }),
    sync({ folder: { id: folderId, path: TARGET.path } })]) {
    const fixture = requestFixture({ rows: [row] })
    const evidence = await inspect(fixture.request)
    assert.equal(evidence.sourceAndImportCoverage, 'covered'); assert.equal(fixture.calls.length, 2)
  }
  const sibling = requestFixture({ rows: [sync({ folder: { id: folderId, path: '/mikka-cloud' }, syncOptions: { includeAllSubFolders: true } })] })
  assert.equal((await inspect(sibling.request)).sourceAndImportCoverage, 'not_covered', 'path segment boundaries are exact')
})

test('same-project imports are followed across known environments, without reading target values', async () => {
  const row = sync({ environment: { id: envIds.staging, slug: 'staging' } })
  const fixture = requestFixture({ rows: [row], imports: {
    'staging:/vercel': [imported('/shared')],
    'prod:/shared': [imported(TARGET.path, 'prod', { folderId: childId })],
  } })
  const evidence = await inspect(fixture.request)
  assert.equal(evidence.sourceAndImportCoverage, 'covered')
  assert.deepEqual(fixture.calls.slice(2), [['imports', 'staging:/vercel'], ['imports', 'prod:/shared']])
  assert.equal(evidence.importEdges.at(-1).to.path, TARGET.path)
})

test('recursive source children use folder-relative paths and their imports are inspected', async () => {
  const fixture = requestFixture({ rows: [sync({ syncOptions: { includeAllSubFolders: true } })], folders: {
    'prod:/vercel': [{ id: childId, envId: envIds.prod, name: 'child', relativePath: '/nested/child' }],
  }, imports: { 'prod:/vercel/nested/child': [imported(TARGET.path, 'prod', { folderId: childId })] } })
  const evidence = await inspect(fixture.request)
  assert.equal(evidence.sourceAndImportCoverage, 'covered')
  assert.deepEqual(fixture.calls.slice(2), [['subfolders', 'prod:/vercel'], ['imports', 'prod:/vercel'], ['imports', 'prod:/vercel/nested/child']])
  assert.throws(() => projectSubfolders({ folders: [{ id: childId, envId: envIds.dev, name: 'x', relativePath: '/x' }] },
    { environment: 'prod', environmentId: envIds.prod, path: '/vercel' }), code('FOLDER_SCOPE'))
})

test('imports are exact-folder reads: importing root does not imply importing all new children', async () => {
  const fixture = requestFixture({ imports: { 'prod:/vercel': [imported('/')] } })
  assert.equal((await inspect(fixture.request)).sourceAndImportCoverage, 'not_covered')
  assert.deepEqual(fixture.calls.slice(2), [['imports', 'prod:/vercel'], ['imports', 'prod:/']])
})

test('unknown or foreign import projects and replication stop before following any edge', async () => {
  for (const row of [imported('/foreign', 'prod', { importEnv: { id: envIds.prod, slug: 'prod', projectId: orgId } }),
    imported('/unknown', 'prod', { importEnv: { id: envIds.prod, slug: 'prod' } }), imported('/copy', 'prod', { isReplication: true })]) {
    const fixture = requestFixture({ imports: { 'prod:/vercel': [row] } }), evidence = newEvidence()
    await assert.rejects(inspect(fixture.request, evidence), code(row.isReplication ? 'IMPORT_MODE_UNRESOLVED' : 'IMPORT_PROJECT_UNRESOLVED'))
    assert.equal(evidence.sourceAndImportCoverage, 'unknown'); assert.equal(fixture.calls.length, 3)
    assert.equal(evidence.importEdges.length, 0)
  }
})

test('wrong source, destination, invalid path and non-boolean recursion cannot become safe evidence', () => {
  for (const [row, expected] of [
    [sync({ projectId: orgId }), 'SYNC_SCOPE'], [sync({ folder: null }), 'SYNC_SOURCE_UNRESOLVED'],
    [sync({ environment: { id: envIds.prod, slug: 'unknown' } }), 'METADATA_SCOPE'],
    [sync({ folder: { id: folderId, path: '/vercel/../other' } }), 'METADATA_SCOPE'],
    [sync({ syncOptions: { includeAllSubFolders: 'false' } }), 'SYNC_OPTIONS_SCHEMA'],
    [sync({ destinationConfig: { scope: 'team' } }), 'DESTINATION_SCOPE'],
    [sync({ connection: { id: connectionId, app: 'vercel', name: TARGET.connection, credentials: {} } }), 'CONNECTION_SCOPE'],
  ]) assert.throws(() => projectSyncs({ secretSyncs: [row] }), code(expected))
  assert.throws(() => projectImports({ secretImports: [imported('/valid', 'prod', { folderId: childId })] },
    { environment: 'prod', path: '/vercel', folderId }), code('IMPORT_FOLDER_SCOPE'))
})

test('cycles terminate with each actual source read once and global limits fail closed', async () => {
  const fixture = requestFixture({ imports: { 'prod:/vercel': [imported('/vercel')] } })
  assert.equal((await inspect(fixture.request)).sourceAndImportCoverage, 'not_covered')
  assert.equal(fixture.calls.length, 3)
  const requests = [], client = metadataClient(fixtureCredential, requests, async () => Response.json({}))
  for (let i = 0; i < LIMITS.requests; i++) await client('project_vercel_syncs')
  assert.throws(() => client('project_vercel_syncs'), code('REQUEST_LIMIT'))
  assert.equal(requests.length, LIMITS.requests)
})

test('HTTP denial ends inspection without reading provider errors or following alternative routes', async () => {
  const requests = [], evidence = newEvidence(); let calls = 0, canceled = false
  const client = metadataClient(fixtureCredential, requests, async () => {
    calls++
    if (calls === 1) return Response.json(audit())
    return { status: 403, body: { cancel: async () => { canceled = true } }, json: () => assert.fail('No provider error body') }
  })
  await assert.rejects(inspect(client, evidence), code('METADATA_HTTP'))
  assert.equal(calls, 2); assert.equal(canceled, true); assert.equal(evidence.sourceAndImportCoverage, 'unknown')
  assert.deepEqual(requests.at(-1), { operation: 'project_vercel_syncs', status: 403 })
})

test('no CLI mode can create a folder, create a key, or mutate a sync', () => {
  const child = spawnSync(process.execPath, [new URL('./infisical-cloud-source-scope.mjs', import.meta.url).pathname, '--apply'], {
    encoding: 'utf8', env: { PATH: process.env.PATH },
  })
  assert.equal(child.status, 1)
  const receipt = JSON.parse(child.stdout.trim())
  assert.equal(receipt.error, 'MODE'); assert.equal(receipt.configurationWrites, 0)
  assert.equal(receipt.applicationSecretValuesRequested, 0); assert.deepEqual(receipt.requests, [])
})

