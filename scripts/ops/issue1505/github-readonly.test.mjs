import test from 'node:test'
import assert from 'node:assert/strict'
import { SmokeGitHubSetupError, createSmokeGitHubFixture, GITHUB_ACCOUNT_ID, GITHUB_LOGIN, REPOSITORY } from './github-readonly-provider.mjs'
import * as readonlyHelper from './github-readonly-helper.mjs'
import { prepareReadOnlyConnection, cleanupReadOnlyConnection, digest, stateFor, assertRepositoryReadback } from './github-readonly-helper.mjs'
const NOW = Date.parse('2026-11-09T02:30:00Z')
const CLIENT = 'Iv1.fake1505'
const PERMS = { metadata: 'read', contents: 'read' }
const source = () => ({ token: 'private-parent-marker', githubAccountId: GITHUB_ACCOUNT_ID, expiresAt: new Date(NOW + 6 * 3600000).toISOString(), metadata: { updatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 6 * 3600000).toISOString() } })
const identity = () => ({ id: Number(GITHUB_ACCOUNT_ID), login: GITHUB_LOGIN, type: 'User' })
const scope = () => ({ app: { id: 123, client_id: CLIENT }, user: identity(), expires_at: new Date(NOW + 4 * 3600000).toISOString(),
  scopes: [], installation: { repository_selection: 'selected', permissions: { ...PERMS }, account: identity() } })
function fixture(change = () => {}) {
  const calls = [], changes = { mint: {}, user: {}, repo: {} }
  change(changes)
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method: init.method, body })
    const failedStatus = changes.failRequest?.({ path, method: init.method, body, authorization: init.headers.authorization })
    if (failedStatus) return Response.json({ message: 'private-provider-body-marker', documentation_url: 'https://private-provider-url-marker.invalid' }, { status: failedStatus })
    if (path.endsWith('/token/scoped')) {
      assert.deepEqual(body.permissions, PERMS)
      assert.deepEqual(body.repositories, ['Mikka-handoff'])
      assert.equal(body.target, GITHUB_LOGIN)
      return Response.json({ ...scope(), token: 'private-child-marker', ...changes.mint })
    }
    if (path.endsWith('/token')) {
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({ ...scope(), token: body.access_token })
    }
    if (path === '/user') return Response.json({ ...identity(), ...changes.user })
    if (path === '/repos/' + REPOSITORY) return Response.json({ id: 456, full_name: REPOSITORY, archived: false, disabled: false,
      permissions: { pull: true, push: true }, ...changes.repo })
    if (path === '/user/installations') return Response.json({ installations: [{ id: 789, app_id: 123, client_id: CLIENT, suspended_at: null, account: identity() }] })
    if (path === '/user/installations/789/repositories') return Response.json({ repositories: [{ id: 456, full_name: REPOSITORY }, { id: 457, full_name: 'alexj11324/metadata-only' }] })
    throw new Error('unexpected_path_private_marker')
  }
  return { calls, provider: createSmokeGitHubFixture({ application: { clientId: CLIENT, clientSecret: 'private-app-marker' }, appId: '123', fetchImpl, now: () => NOW, credentials: {} }) }
}
const prepare = f => f.provider.prepareChild(source(), { minimumSourceValidityMs: 600000, requireSourceProviderExpiry: true })
test('fresh child requests exactly two read permissions; role push=true is not token authority', async () => {
  const f = fixture(), result = await prepare(f)
  assert.equal(result.metadata.repositoryId, '456')
  assert.equal(result.metadata.otherRepositoryMetadataCount, 1)
  assert.equal(result.metadata.appClientId, CLIENT)
  assert.equal(result.tokenSha256, digest('private-child-marker'))
  assert.equal(f.calls.some(call => call.path.endsWith('/grant')), false)
})
for (const [name, change] of [
  ['write permission', x => { x.mint.installation = { ...scope().installation, permissions: { metadata: 'read', contents: 'write' } } }],
  ['extra permission', x => { x.mint.installation = { ...scope().installation, permissions: { ...PERMS, pull_requests: 'write' } } }],
  ['all repositories', x => { x.mint.installation = { ...scope().installation, repository_selection: 'all' } }],
  ['wrong App', x => { x.mint.app = { client_id: 'other' } }],
  ['wrong principal', x => { x.user.id = 999 }],
  ['wrong repository', x => { x.repo.full_name = 'alexj11324/other' }],
  ['expired child', x => { x.mint.expires_at = new Date(NOW - 1).toISOString() }],
  ['same source child', x => { x.mint.token = source().token }],
  ['unexpected OAuth scope', x => { x.mint.scopes = ['repo'] }],
]) test('provider rejects ' + name, async () => { await assert.rejects(prepare(fixture(change)), /^Error: issue1505_github_|^SmokeGitHubSetupError: issue1505_github_/) })

function orchestration(overrides = {}) {
  const calls = [], checkpoints = []
  const prepared = { token: 'private-child-marker', tokenSha256: digest('private-child-marker'), providerExpiry: NOW + 4 * 3600000,
    metadata: { appId: '123', appClientId: CLIENT, repositoryId: '456', installationId: '789' } }
  const state = stateFor(prepared, { updatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3 * 3600000).toISOString() })
  const provider = { clientId: CLIENT, async prepareChild(value, opts) { calls.push('mint'); await opts.onMint(prepared.token); return prepared },
    async revokeConfirmed(token) { assert.equal(token, prepared.token); calls.push('revoke'); return { kind: 'delete_token', status: 204 } } }
  const store = {
    async identity() { calls.push('identity') }, async idle() { calls.push('idle') },
    async assertVacant() { calls.push('vacant') }, async prepareOwnerSource(beforeGetter) { calls.push('normal_owner_resolution'); await beforeGetter(); return source().metadata }, async ownerSourceNoRefresh() { calls.push('source_no_refresh'); return source() },
    async install(owner, child, beforeCommit) { calls.push('install'); await beforeCommit(state); calls.push('commit'); return state },
    async listRepositories() { calls.push('readback'); return { githubAccountId: GITHUB_ACCOUNT_ID, login: GITHUB_LOGIN,
      repositories: [{ id: '456', installationId: '789', fullName: REPOSITORY }] } },
    async assertOwnerUnchanged() { calls.push('owner_unchanged') },
    async matchingToken() { calls.push('match'); return prepared.token },
    async disconnectMatching() { calls.push('disconnect') },
    ...overrides,
  }
  const checkpoint = async report => { checkpoints.push(JSON.parse(JSON.stringify(report))) }
  return { provider, store, state, calls, checkpoints, checkpoint, now: () => NOW }
}
test('successful repair uses normal readback, retains new child and emits no secrets', async () => {
  const f = orchestration(), r = await prepareReadOnlyConnection(f)
  assert.equal(r.status, 'passed'); assert.equal(r.ownerRefreshAttempted, true)
  assert.equal(r.ownerSourceBaseline, 'after_normal_token_resolution')
  assert.equal(r.ownerTokenResolution.actualRefresh, 'not_independently_observed')
  assert.equal(r.ownerTokenResolution.persistedMetadataChanged, false)
  assert.equal(r.ownerUnchanged, true); assert.equal(f.calls.includes('revoke'), false)
  assert.ok(f.calls.indexOf('commit') < f.calls.indexOf('readback'))
  assert.equal(JSON.stringify(f.checkpoints).includes('private-'), false)
})
test('existing connection fails before obtaining Owner source or minting', async () => {
  const f = orchestration({ async assertVacant() { throw new Error('issue1505_github_smoke_connection_exists') } })
  const r = await prepareReadOnlyConnection(f)
  assert.equal(r.status, 'incomplete'); assert.equal(f.calls.includes('mint'), false)
  assert.equal(f.calls.includes('source_no_refresh'), false)
})
test('a failed post-resolution Owner source stops minting', async () => {
  const f = orchestration({ async ownerSourceNoRefresh() { throw new Error('issue1505_github_owner_source_not_fresh') } })
  const r = await prepareReadOnlyConnection(f); assert.equal(r.status, 'incomplete'); assert.equal(f.calls.includes('mint'), false)
})
test('precommit refusal revokes only the newly minted token', async () => {
  const f = orchestration({ async install() { throw new Error('issue1505_github_smoke_connection_exists') } })
  const r = await prepareReadOnlyConnection(f); assert.equal(r.changed, false); assert.equal(f.calls.filter(x => x === 'revoke').length, 1)
  assert.equal(f.calls.includes('disconnect'), false)
})
test('ambiguous COMMIT preserves safe recovery state and never blindly revokes', async () => {
  let f
  f = orchestration({ async install(owner, child, beforeCommit) { await beforeCommit(f.state); throw new Error('private-database-detail') } })
  const r = await prepareReadOnlyConnection(f)
  assert.equal(r.commitUnconfirmed, true); assert.equal(r.changed, null); assert.deepEqual(r.state, f.state)
  assert.equal(f.calls.includes('revoke'), false); assert.equal(f.calls.includes('disconnect'), false)
  assert.equal(r.code, 'issue1505_github_dependency_failed'); assert.equal(JSON.stringify(f.checkpoints).includes('private-'), false)
})
test('readback failure cleans only the known installed child', async () => {
  const f = orchestration({ async listRepositories() { return { repositories: [] } } })
  const r = await prepareReadOnlyConnection(f)
  assert.equal(r.status, 'incomplete'); assert.equal(r.changed, false); assert.equal(r.cleanup.status, 'passed')
  assert.ok(f.calls.indexOf('match') < f.calls.indexOf('revoke')); assert.ok(f.calls.indexOf('revoke') < f.calls.indexOf('disconnect'))
})
test('foreign connection blocks cleanup without revoking or deleting it', async () => {
  const f = orchestration({ async matchingToken() { throw new Error('issue1505_github_smoke_connection_changed') } })
  const r = await cleanupReadOnlyConnection({ ...f, state: f.state })
  assert.equal(r.status, 'incomplete'); assert.equal(f.calls.includes('revoke'), false); assert.equal(f.calls.includes('disconnect'), false)
})
test('changed App rejects cleanup before reading a token', async () => {
  const f = orchestration(); f.provider.clientId = 'other'
  const r = await cleanupReadOnlyConnection({ ...f, state: f.state })
  assert.equal(r.code, 'issue1505_github_app_configuration_changed'); assert.equal(f.calls.includes('match'), false)
})
test('wrong state principal rejects cleanup before storage/provider IO', async () => {
  const f = orchestration(), r = await cleanupReadOnlyConnection({ ...f, state: { ...f.state, userId: 'other' } })
  assert.equal(r.status, 'incomplete'); assert.deepEqual(f.calls, [])
})
test('normal repository readback must match exact GitHub subject and installation', () => {
  const f = orchestration()
  assert.throws(() => assertRepositoryReadback({ githubAccountId: 'other', login: GITHUB_LOGIN, repositories: [] }, f.state))
})

import { createStore } from './github-readonly-store.mjs'
import { configuration, run, readRepositoriesForVerifiedApp } from './github-readonly-runner.mjs'
import { SMOKE_USER_ID, OWNER_USER_ID } from './github-readonly-provider.mjs'
function transport({ occupied = false, commitError = false, ownerChanged = false } = {}) {
  const events = [], row = { userId: OWNER_USER_ID, githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN,
    accessToken: 'sealed-parent', hasRefreshToken: true, refreshTokenExpiresAt: new Date(NOW + 8 * 3600000),
    updatedAt: new Date(NOW), accessTokenExpiresAt: new Date(NOW + 6 * 3600000) }
  const parent = { ...source(), metadata: { updatedAt: row.updatedAt.toISOString(), expiresAt: row.accessTokenExpiresAt.toISOString(), hasRefreshToken: true },
    sealedFingerprint: digest(row.accessToken) }
  let stored = occupied ? { userId: SMOKE_USER_ID } : null, current
  const client = {
    async query(statement, params) {
      const text = typeof statement === 'string' ? statement : statement.text
      events.push({ text, params })
      if (text.includes('AS runs')) return { rows: [{ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0 }] }
      if (text.includes('FROM account')) return { rows: [] }
      if (text.includes('FROM github_connections')) {
        if (params[0] === OWNER_USER_ID) return { rows: [{ ...row, ...(ownerChanged ? { updatedAt: new Date(NOW + 1) } : {}) }] }
        return { rows: stored ? [stored] : [] }
      }
      if (text === 'COMMIT' && commitError) throw new Error('commit_transport_private_marker')
      return { rows: [] }
    },
    release(broken) { events.push({ release: broken }) },
  }
  const connection = {
    async unsealGitHubSecret(value) { return value === 'sealed-parent' ? parent.token : 'private-child-marker' },
    async saveGitHubConnection(userId, identity, token) {
      assert.equal(current, client); assert.equal(userId, SMOKE_USER_ID); assert.equal(Object.hasOwn(token, 'refresh_token'), false)
      events.push({ saved: userId })
      stored = { userId, ...identity, accessToken: 'sealed-child', hasRefreshToken: false, refreshTokenExpiresAt: null,
        updatedAt: new Date(NOW), accessTokenExpiresAt: new Date(NOW + token.expires_in * 1000) }
    },
    async disconnectGitHub(userId) { assert.equal(current, client); assert.equal(userId, SMOKE_USER_ID); events.push({ deleted: userId }); stored = null },
  }
  const store = createStore({ pool: { query: client.query.bind(client), async connect() { return client } }, connection,
    async withDatabaseClient(value, work) { current = value; try { return await work() } finally { current = undefined } },
    listRepositoriesForUser: async () => ({}), now: () => NOW })
  const prepared = { token: 'private-child-marker', tokenSha256: digest('private-child-marker'), providerExpiry: NOW + 4 * 3600000,
    metadata: { appId: '123', appClientId: CLIENT, repositoryId: '456', installationId: '789' } }
  return { store, events, parent, prepared }
}
test('store holds Owner lock, rechecks vacancy and uses normal scoped-client save before COMMIT', async () => {
  const f = transport()
  const state = await f.store.install(f.parent, f.prepared, async () => { f.events.push({ checkpoint: true }) })
  assert.equal(state.userId, SMOKE_USER_ID)
  assert.ok(f.events.some(e => e.text?.includes('FOR SHARE') && e.params[0] === OWNER_USER_ID))
  assert.ok(f.events.findIndex(e => e.saved) < f.events.findIndex(e => e.checkpoint))
  assert.ok(f.events.findIndex(e => e.checkpoint) < f.events.findIndex(e => e.text === 'COMMIT'))
  assert.deepEqual(f.events.at(-1), { release: false })
  assert.equal(f.events.some(e => e.saved === OWNER_USER_ID), false)
})
test('store concurrent existing Smoke row refuses before save and rolls back', async () => {
  const f = transport({ occupied: true })
  await assert.rejects(f.store.install(f.parent, f.prepared, async () => {}), /smoke_connection_exists/)
  assert.equal(f.events.some(e => e.saved), false)
  assert.ok(f.events.some(e => e.text === 'ROLLBACK')); assert.deepEqual(f.events.at(-1), { release: true })
})
test('store changed Owner refuses before saving child', async () => {
  const f = transport({ ownerChanged: true })
  await assert.rejects(f.store.install(f.parent, f.prepared, async () => {}), /owner_connection_changed/)
  assert.equal(f.events.some(e => e.saved), false)
})
test('store failed COMMIT retains checkpoint, closes broken client, does not delete row', async () => {
  const f = transport({ commitError: true }); let checkpoint
  await assert.rejects(f.store.install(f.parent, f.prepared, async state => { checkpoint = state }), /commit_transport/)
  assert.equal(checkpoint.tokenSha256, digest('private-child-marker'))
  assert.deepEqual(f.events.at(-1), { release: true }); assert.equal(f.events.some(e => e.deleted), false)
})
test('runner default disabled fails before loading any credential or application dependency', async () => {
  let loaded = false
  const result = await run(['--prepare'], {}, { load: async () => { loaded = true }, write: async () => {} })
  assert.equal(loaded, false); assert.equal(result.code, 'issue1505_github_execution_not_enabled')
})
test('runner exact execution guard rejects rerun, foreign repo, branch and missing GO', () => {
  const env = { CI: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REF: 'refs/heads/acceptance/issues-1504-1506', MIKKA_GITHUB_REPAIR_GO: 'root-reviewed-1506-r7-20261109t1622',
    MIKKA_EDITION: 'cloud', NODE_ENV: 'production' }
  assert.deepEqual(configuration(['--prepare'], env), { operation: 'prepare' })
  for (const [key, value] of [['GITHUB_RUN_ATTEMPT', '2'], ['GITHUB_REPOSITORY', 'other'], ['GITHUB_REF', 'refs/heads/main'], ['MIKKA_GITHUB_REPAIR_GO', '']])
    assert.throws(() => configuration(['--prepare'], { ...env, [key]: value }), /execution_not_enabled/)
})

test('lost mint response records unknown outcome and performs no retry or speculative revocation', async () => {
  const f = orchestration()
  f.provider.prepareChild = async (source, options) => {
    await options.stage('mint_scoped_token')
    throw new Error('issue1505_github_provider_transport')
  }
  const result = await prepareReadOnlyConnection(f)
  assert.equal(result.mintAttempted, true); assert.equal(result.mintOutcome, 'unknown')
  assert.equal(f.calls.includes('revoke'), false); assert.equal(f.calls.includes('install'), false)
  assert.ok(f.checkpoints.some(row => row.stage === 'mint_request' && row.mintOutcome === 'unknown'))
})

test('normal repository readback binds only provider-verified public App ID and restores its environment', async () => {
  const env = { MIKKA_EDITION: 'cloud' }
  let called = 0
  const normal = async userId => {
    called++; assert.equal(userId, SMOKE_USER_ID)
    assert.equal(env.GITHUB_APP_ID, '77')
    return { repositories: [] }
  }
  await readRepositoriesForVerifiedApp(normal, SMOKE_USER_ID, '77', env)
  assert.equal(called, 1); assert.equal(Object.hasOwn(env, 'GITHUB_APP_ID'), false)
})
test('normal repository readback rejects conflicting App configuration and restores after failure', async () => {
  const env = { GITHUB_APP_ID: '88' }; let called = 0
  await assert.rejects(readRepositoriesForVerifiedApp(async () => { called++ }, SMOKE_USER_ID, '77', env), /app_configuration_changed/)
  assert.equal(called, 0); assert.equal(env.GITHUB_APP_ID, '88')
  const cause = new Error('synthetic normal read failure')
  await assert.rejects(readRepositoriesForVerifiedApp(async () => { throw cause }, SMOKE_USER_ID, '88', env), error => error === cause)
  assert.equal(env.GITHUB_APP_ID, '88')
})

test('closed diagnostics reject identifier-shaped foreign messages and preserve only listed codes', async () => {
  const { safeCode } = await import('./github-readonly-helper.mjs')
  assert.equal(safeCode(new Error('issue1505_github_ghp_syntheticprivate')), 'issue1505_github_dependency_failed')
  assert.equal(safeCode(new Error('issue1505_github_provider_transport')), 'issue1505_github_provider_transport')
  assert.equal(safeCode({ message: 'issue1505_github_unknown_workspace_identifier' }), 'issue1505_github_dependency_failed')
})

function lockedOwnerFixture({ rowChange = () => {}, getterError = false, commitError = false } = {}) {
  const events = []
  const row = { userId: OWNER_USER_ID, githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN,
    updatedAt: new Date(NOW - 1000), accessTokenExpiresAt: new Date(NOW - 1), accessToken: 'sealed-before', hasRefreshToken: true }
  rowChange(row)
  let locked = false, committed = false
  const store = createStore({
    pool: { async query() { events.push('post_commit_read'); assert.equal(committed, true); return { rows: [row] } } },
    now: () => NOW,
    withOwnerConnectionLock: async work => {
      events.push('lock'); locked = true
      try {
        const result = await work(row)
        if (commitError) throw new Error('private-commit-marker')
        committed = true; events.push('commit'); return result
      } catch (error) { events.push('rollback_or_unknown'); throw error }
      finally { locked = false }
    },
    connection: {
      async githubConnectionToken(userId, options) {
        assert.equal(locked, true); assert.equal(userId, OWNER_USER_ID); assert.deepEqual(options, { minValidityMs: 660000 })
        events.push('normal_getter')
        if (getterError) throw new Error('private-refresh-marker')
        row.updatedAt = new Date(NOW); row.accessTokenExpiresAt = new Date(NOW + 6 * 3600000); row.accessToken = 'sealed-after'
        return { token: 'private-discarded-getter-token', githubAccountId: GITHUB_ACCOUNT_ID, expiresAt: row.accessTokenExpiresAt }
      },
      async unsealGitHubSecret(value) {
        assert.equal(value, 'sealed-after'); assert.equal(committed, true); events.push('unseal_after_commit')
        return 'private-post-commit-source'
      },
    },
  })
  return { store, events, row, committed: () => committed }
}

test('an expired original Owner source resolves under its lock and only the committed reread reaches the child provider', async () => {
  const locked = lockedOwnerFixture()
  const f = orchestration({
    prepareOwnerSource: locked.store.prepareOwnerSource,
    ownerSourceNoRefresh: locked.store.ownerSourceNoRefresh,
  })
  const originalPrepare = f.provider.prepareChild
  f.provider.prepareChild = async (actualSource, options) => {
    assert.equal(locked.committed(), true)
    assert.equal(actualSource.token, 'private-post-commit-source')
    assert.notEqual(actualSource.token, 'private-discarded-getter-token')
    return originalPrepare(actualSource, options)
  }
  const report = await prepareReadOnlyConnection(f)
  assert.equal(report.status, 'passed')
  assert.equal(report.ownerTokenResolution.status, 'committed')
  assert.equal(report.ownerTokenResolution.persistedMetadataChanged, true)
  assert.equal(report.ownerSourceBaseline, 'after_normal_token_resolution')
  assert.deepEqual(locked.events, ['lock', 'normal_getter', 'commit', 'post_commit_read', 'unseal_after_commit'])
  assert.doesNotMatch(JSON.stringify(f.checkpoints), /private-|sealed-/)
})

for (const phase of ['identity', 'idle', 'assertVacant']) test('refusal at ' + phase + ' never resolves Owner credentials or mints', async () => {
  const f = orchestration({ async [phase]() { throw new Error('issue1505_github_smoke_work_active') } })
  const r = await prepareReadOnlyConnection(f)
  assert.equal(r.status, 'incomplete')
  assert.equal(r.ownerRefreshAttempted, false)
  assert.equal(f.calls.includes('normal_owner_resolution'), false)
  assert.equal(f.calls.includes('source_no_refresh'), false)
  assert.equal(f.calls.includes('mint'), false)
})

test('the locked Owner identity and finite dates are checked before any normal getter', async () => {
  for (const change of [
    row => { row.userId = 'foreign' }, row => { row.githubAccountId = '999' }, row => { row.githubLogin = 'foreign' },
    row => { row.accessTokenExpiresAt = null }, row => { row.accessTokenExpiresAt = new Date('invalid') },
    row => { row.updatedAt = null }, row => { row.updatedAt = new Date('invalid') },
  ]) {
    const f = lockedOwnerFixture({ rowChange: change })
    await assert.rejects(f.store.prepareOwnerSource(), /owner_source_not_fresh/)
    assert.equal(f.events.includes('normal_getter'), false)
    assert.equal(f.events.includes('post_commit_read'), false)
  }
})

test('an unpersisted refresh intent stops before the getter', async () => {
  const f = lockedOwnerFixture()
  await assert.rejects(f.store.prepareOwnerSource(async () => { throw new Error('checkpoint_failed') }), /checkpoint_failed/)
  assert.equal(f.events.includes('normal_getter'), false)
  assert.equal(f.committed(), false)
})

for (const mode of ['getterError', 'commitError']) test(mode + ' preserves possible refresh evidence without mint, retry or Owner revocation', async () => {
  const locked = lockedOwnerFixture({ [mode]: true })
  const f = orchestration({ prepareOwnerSource: locked.store.prepareOwnerSource, ownerSourceNoRefresh: locked.store.ownerSourceNoRefresh })
  const r = await prepareReadOnlyConnection(f)
  assert.equal(r.status, 'incomplete')
  assert.equal(r.ownerRefreshAttempted, true)
  assert.equal(r.ownerTokenResolution.status, 'attempting')
  assert.equal(r.ownerTokenResolution.actualRefresh, 'not_independently_observed')
  assert.equal(r.code, 'issue1505_github_dependency_failed')
  assert.equal(locked.events.filter(x => x === 'normal_getter').length, 1)
  assert.equal(locked.events.includes('post_commit_read'), false)
  assert.equal(f.calls.includes('mint'), false)
  assert.equal(f.calls.includes('revoke'), false)
  assert.equal(f.calls.includes('disconnect'), false)
  assert.doesNotMatch(JSON.stringify(f.checkpoints), /private-|sealed-/)
})

test('cleanup never resolves or refreshes an Owner connection', async () => {
  const f = orchestration({ async prepareOwnerSource() { assert.fail('cleanup cannot refresh Owner') } })
  const report = await cleanupReadOnlyConnection({ ...f, state: f.state })
  assert.equal(report.status, 'passed')
  assert.equal(f.calls.includes('normal_owner_resolution'), false)
  assert.equal(f.calls.includes('source_no_refresh'), false)
  assert.equal(f.calls.filter(x => x === 'revoke').length, 1)
})

test('provider diagnostics copy only closed request phases and integer HTTP status, never raw details', () => {
  const { safeProviderFailure } = readonlyHelper
  assert.equal(typeof safeProviderFailure, 'function')
  const hidden = { body: 'private-body-marker', token: 'private-token-marker', url: 'private-url-marker',
    headers: { authorization: 'private-header-marker' } }
  const http = new SmokeGitHubSetupError('provider_http', { stage: 'scoped_repository', status: 403, ...hidden },
    { cause: new Error('private-cause-marker') })
  assert.deepEqual(safeProviderFailure(http), { stage: 'scoped_repository', status: 403 })
  for (const code of ['provider_transport', 'provider_schema']) {
    assert.deepEqual(safeProviderFailure(new SmokeGitHubSetupError(code, { stage: 'check_scoped_token', status: 403, ...hidden })),
      { stage: 'check_scoped_token' })
  }
  assert.doesNotMatch(JSON.stringify(safeProviderFailure(http)), /private-/)
})
test('provider diagnostics reject foreign error objects, unknown phases, invalid statuses and unrelated codes', () => {
  const { safeProviderFailure } = readonlyHelper
  assert.equal(typeof safeProviderFailure, 'function')
  const errors = [
    { message: 'issue1505_github_provider_http', code: 'provider_http', details: { stage: 'scoped_identity', status: 403 } },
    new Error('issue1505_github_provider_http'),
    new SmokeGitHubSetupError('provider_http', { stage: 'private-stage-marker', status: 403 }),
    new SmokeGitHubSetupError('identity_mismatch', { stage: 'scoped_identity', status: 403 }),
    ...[undefined, null, '403', 0, 99, 600, 403.1, Infinity, NaN].map(status =>
      new SmokeGitHubSetupError('provider_http', { stage: 'scoped_identity', status })),
  ]
  for (const error of errors) assert.equal(safeProviderFailure(error), undefined)
})
for (const [stage, path, status] of [
  ['scoped_identity', '/user', 401],
  ['check_scoped_token', '/applications/' + CLIENT + '/token', 404],
  ['scoped_repository', '/repos/' + REPOSITORY, 403],
  ['scoped_installations', '/user/installations', 500],
  ['scoped_installation_repositories', '/user/installations/789/repositories', 403],
]) test('post-mint ' + stage + ' HTTP failure records safe detail and revokes only the uninstalled new child', async () => {
  const real = fixture(changes => {
    changes.failRequest = request => request.path === path && request.method !== 'DELETE'
      && (request.authorization === 'Bearer private-child-marker' || request.body?.access_token === 'private-child-marker')
      ? status : undefined
  })
  const f = orchestration(); f.provider = real.provider
  const report = await prepareReadOnlyConnection(f)
  assert.equal(report.status, 'incomplete'); assert.equal(report.changed, false)
  assert.equal(report.mintOutcome, 'received')
  assert.equal(report.code, 'issue1505_github_provider_http')
  assert.deepEqual(report.providerFailure, { stage, status })
  assert.deepEqual(report.newChildRevocation, { kind: 'delete_token', status: 204 })
  assert.equal(f.calls.includes('install'), false); assert.equal(f.calls.includes('disconnect'), false)
  const deletions = real.calls.filter(call => call.method === 'DELETE')
  assert.deepEqual(deletions, [{ path: '/applications/' + CLIENT + '/token', method: 'DELETE', body: { access_token: 'private-child-marker' } }])
  assert.equal(real.calls.some(call => call.path.endsWith('/grant')), false)
  assert.doesNotMatch(JSON.stringify(f.checkpoints), /private-|authorization|documentation_url/)
})
test('cleanup HTTP failure keeps exact state and connection without leaking provider details', async () => {
  const f = orchestration()
  f.provider.revokeConfirmed = async () => { throw new SmokeGitHubSetupError('provider_http',
    { stage: 'revoke_scoped_token', status: 503, body: 'private-cleanup-marker' }) }
  const report = await cleanupReadOnlyConnection({ ...f, state: f.state })
  assert.equal(report.status, 'incomplete'); assert.equal(report.revoked, false); assert.equal(report.disconnected, false)
  assert.deepEqual(report.providerFailure, { stage: 'revoke_scoped_token', status: 503 })
  assert.equal(f.calls.includes('disconnect'), false)
  assert.doesNotMatch(JSON.stringify(f.checkpoints), /private-/)
})
