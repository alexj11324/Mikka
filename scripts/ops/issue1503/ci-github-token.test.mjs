import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ciAuthErrorCode, ciCredentialSelect, loadCiGithubToken, protectCiCredentialPools } from './ci-github-token.mjs'
import { runDeliveryWithCiToken } from './delivery-with-ci-token.mjs'

const actualFixture = {"issue":1503,"workspaceId":"93f38d33-9447-4eaf-8a46-0d8889165bcd","ownerUserId":"XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ","smokeUserId":"cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3","shareBefore":{"shared":false,"allowOthers":false,"allowed":true},"e2bChanged":true,"e2bSetup":{"userId":"cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3","updatedAt":"2026-11-06T18:21:51.895Z"},"githubSetup":{"version":1,"issue":1503,"userId":"cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3","ownerUserId":"XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ","githubAccountId":"183887963","githubLogin":"alexj11324","repository":"alexj11324/Mikka-handoff","appId":"4840908","repositoryId":"1436202099","installationId":"173164679","listedRepositoryCount":53,"otherRepositoryMetadataCount":52,"checkTokenScopeConfirmed":false,"providerExpiresAt":"2026-11-08T17:15:43.000Z","connectionExpiresAt":"2026-11-08T16:05:40.679Z","connectionUpdatedAt":"2026-11-08T12:05:50.680Z","tokenSha256":"968e6d51eb0b964835649170317090e038f2a67361a975e06302029d8773698b"}}
const token = 'unit-test-read-credential'
const fixture = () => ({ ...structuredClone(actualFixture), githubSetup: {
  ...actualFixture.githubSetup, tokenSha256: createHash('sha256').update(token).digest('hex') } })
const now = Date.parse('2026-11-08T13:00:00Z')
function setup(input = fixture()) {
  const calls = { queries: [], unseals: [], close: 0, runtime: 0 }
  const state = input.githubSetup
  const row = { userId: input.smokeUserId, githubAccountId: state.githubAccountId, githubLogin: state.githubLogin,
    accessToken: 'unit-test-sealed-value', updatedAt: new Date(state.connectionUpdatedAt),
    accessTokenExpiresAt: new Date(state.connectionExpiresAt), refreshTokenMissing: true, refreshExpiryMissing: true }
  const runtime = { query: async (...args) => { calls.queries.push(args); return { rows: [row] } },
    unseal: async value => { calls.unseals.push(value); return token }, close: async () => { calls.close += 1 } }
  const options = { now, runtimeFactory: async () => { calls.runtime += 1; return runtime } }
  return { input, calls, row, runtime, options }
}

test('loads only the exact existing Smoke child with one CAS SELECT and closes the runtime', async () => {
  const x = setup()
  assert.equal(await loadCiGithubToken(x.input, x.options), token)
  assert.equal(x.calls.queries.length, 1)
  assert.equal(x.calls.queries[0][0], ciCredentialSelect)
  assert.deepEqual(x.calls.queries[0][1], [x.input.smokeUserId, x.input.githubSetup.connectionUpdatedAt, x.input.githubSetup.connectionExpiresAt])
  assert.equal(/\b(?:INSERT|UPDATE|DELETE|FOR UPDATE)\b/i.test(ciCredentialSelect), false)
  assert.deepEqual(x.calls.unseals, ['unit-test-sealed-value'])
  assert.equal(x.calls.close, 1)
})

test('foreign fixture identities or expired fixtures fail before any runtime or DB read', async () => {
  for (const mutate of [
    f => { f.smokeUserId = f.ownerUserId },
    f => { f.githubSetup.userId = f.ownerUserId },
    f => { f.workspaceId = '00000000-0000-0000-0000-000000000000' },
    f => { f.githubSetup.githubAccountId = '1' },
    f => { f.githubSetup.repository = 'another/repository' },
    f => { f.githubSetup.connectionExpiresAt = '2026-11-08T12:30:00Z' },
  ]) {
    const x = setup(); mutate(x.input)
    await assert.rejects(loadCiGithubToken(x.input, x.options), /^Error: issue1503_ci_auth_(?:fixture_mismatch|fixture_expired)$/)
    assert.equal(x.calls.runtime, 0); assert.equal(x.calls.queries.length, 0); assert.equal(x.calls.unseals.length, 0)
  }
})

test('changed row identity, timestamps or a refresh credential fail before unsealing', async () => {
  for (const mutate of [
    r => { r.userId = actualFixture.ownerUserId },
    r => { r.githubAccountId = '1' },
    r => { r.githubLogin = 'another-user' },
    r => { r.updatedAt = new Date('2026-11-08T12:06:00Z') },
    r => { r.accessTokenExpiresAt = new Date('2026-11-08T16:06:00Z') },
    r => { r.refreshTokenMissing = false },
    r => { r.refreshExpiryMissing = false },
  ]) {
    const x = setup(); mutate(x.row)
    await assert.rejects(loadCiGithubToken(x.input, x.options), /^Error: issue1503_ci_auth_connection_changed$/)
    assert.equal(x.calls.queries.length, 1); assert.equal(x.calls.unseals.length, 0); assert.equal(x.calls.close, 1)
  }
})

test('missing rows and changed token fingerprints fail with closed error codes', async () => {
  const missing = setup(); missing.runtime.query = async () => ({ rows: [] })
  await assert.rejects(loadCiGithubToken(missing.input, missing.options), /^Error: issue1503_ci_auth_connection_changed$/)
  assert.equal(missing.calls.unseals.length, 0); assert.equal(missing.calls.close, 1)
  const changed = setup(); changed.runtime.unseal = async () => 'different-unit-token'
  await assert.rejects(loadCiGithubToken(changed.input, changed.options), /^Error: issue1503_ci_auth_token_changed$/)
  assert.equal(changed.calls.close, 1)
})

test('dependency and cleanup errors retain causes while public codes contain no dependency text', async () => {
  const x = setup(); const cause = new Error('private-test-value')
  x.runtime.query = async () => { throw cause }
  await assert.rejects(loadCiGithubToken(x.input, x.options), e => e.message === 'issue1503_ci_auth_read_failed' && e.cause === cause)
  assert.equal(x.calls.close, 1)
  const y = setup(); y.runtime.close = async () => { throw cause }
  await assert.rejects(loadCiGithubToken(y.input, y.options), e => e.message === 'issue1503_ci_auth_close_failed' && e.cause === cause)
  assert.equal(ciAuthErrorCode(cause), 'issue1503_ci_auth_preflight_failed')
  assert.equal(ciAuthErrorCode(new Error('issue1503_ci_auth_not-a-closed-code')), 'issue1503_ci_auth_preflight_failed')
})

test('wrapper passes the credential only to the child environment after loading and preserves exit status', async () => {
  const order = [], original = process.env.ISSUE1503_CI_GITHUB_TOKEN
  let observed
  const code = await runDeliveryWithCiToken({
    readFixture: async () => { order.push('read'); return fixture() },
    loadToken: async () => { order.push('load-and-close'); return token },
    spawnChild: (...args) => { order.push('spawn'); observed = args; const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 7)); return child },
  })
  assert.deepEqual(order, ['read', 'load-and-close', 'spawn'])
  assert.equal(code, 7); assert.equal(observed[2].env.ISSUE1503_CI_GITHUB_TOKEN, token)
  assert.equal(observed[1].includes(token), false); assert.equal(observed[2].shell, false)
  assert.equal(process.env.ISSUE1503_CI_GITHUB_TOKEN, original)
})

test('a rejected credential never starts the delivery task and child errors retain their cause', async () => {
  let starts = 0
  await assert.rejects(runDeliveryWithCiToken({ readFixture: async () => fixture(), loadToken: async () => { throw new Error('issue1503_ci_auth_token_changed') },
    spawnChild: () => { starts += 1 } }), /^Error: issue1503_ci_auth_token_changed$/)
  assert.equal(starts, 0)
  const cause = new Error('unit-spawn-error')
  await assert.rejects(runDeliveryWithCiToken({ readFixture: async () => fixture(), loadToken: async () => token,
    spawnChild: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', cause)); return child } }),
    e => e.message === 'issue1503_ci_auth_spawn_failed' && e.cause === cause)
})

function pristinePool() {
  return Object.assign(new EventEmitter(), { options: {}, totalCount: 0, idleCount: 0, waitingCount: 0 })
}
function guardedClient(query) {
  return Object.assign(new EventEmitter(), {
    connection: new EventEmitter(), status: 'T', query,
    getTransactionStatus() { return this.status },
  })
}
function checkout(pool, client) {
  return new Promise((resolve, reject) => pool.options.verify(client, cause => cause ? reject(cause) : resolve(client)))
}

test('both pools must be pristine and have no old setup hook before either is changed', () => {
  for (const change of [
    p => { p.totalCount = 1 }, p => { p.idleCount = 1 }, p => { p.waitingCount = 1 },
    p => { p.options.verify = () => {} }, p => { p.options.onConnect = () => {} },
    p => { Object.preventExtensions(p.options) },
  ]) {
    const first = pristinePool(), second = pristinePool()
    change(second)
    assert.throws(() => protectCiCredentialPools(first, second), /^Error: issue1503_ci_auth_runtime_failed$/)
    assert.equal(Object.hasOwn(first.options, 'verify'), false)
    assert.equal(first.listenerCount('release'), 0)
  }
  const same = pristinePool()
  assert.throws(() => protectCiCredentialPools(same, same), /^Error: issue1503_ci_auth_runtime_failed$/)
})

test('new-client verification waits for both commands before permitting checkout', async () => {
  const app = pristinePool(), workspace = pristinePool()
  const healthy = protectCiCredentialPools(app, workspace)
  let begin, show, borrowed = false, calls = 0
  const client = guardedClient(() => {
    calls += 1
    return new Promise(resolve => { if (calls === 1) begin = resolve; else show = resolve })
  })
  const pending = checkout(app, client).then(value => { borrowed = true; return value })
  assert.equal(borrowed, false); assert.equal(calls, 1)
  begin({ rows: [] }); await Promise.resolve()
  assert.equal(borrowed, false); assert.equal(calls, 2)
  show({ rows: [{ transaction_read_only: 'on' }] })
  assert.equal(await pending, client); assert.equal(borrowed, true)
  healthy()
  assert.equal(calls, 2)
})

test('BEGIN or SHOW failures preserve the first cause and never borrow the client', async () => {
  for (const failingCommand of [1, 2]) {
    const app = pristinePool(), workspace = pristinePool()
    const healthy = protectCiCredentialPools(app, workspace)
    const cause = new Error('private-pg-command-error')
    let calls = 0, borrowed = false
    const client = guardedClient(async () => {
      calls += 1
      if (calls === failingCommand) throw cause
      return { rows: [] }
    })
    await assert.rejects(checkout(app, client).then(() => { borrowed = true }),
      e => e.message === 'issue1503_ci_auth_runtime_failed' && e.cause === cause
        && ciAuthErrorCode(e) === 'issue1503_ci_auth_runtime_failed')
    assert.equal(borrowed, false); assert.equal(calls, failingCommand)
    assert.throws(healthy, e => e.message === 'issue1503_ci_auth_runtime_failed' && e.cause === cause)
  }
})

test('SHOW must prove one read-only row and an active transaction', async () => {
  for (const input of [
    { rows: [], status: 'T' },
    { rows: [{ transaction_read_only: 'off' }], status: 'T' },
    { rows: [{ transaction_read_only: 'on' }, { transaction_read_only: 'on' }], status: 'T' },
    { rows: [{ transaction_read_only: 'on' }], status: 'I' },
  ]) {
    const app = pristinePool(), workspace = pristinePool()
    protectCiCredentialPools(app, workspace)
    let calls = 0, borrowed = false
    const client = guardedClient(async () => (++calls === 1 ? { rows: [] } : { rows: input.rows }))
    client.status = input.status
    await assert.rejects(checkout(app, client).then(() => { borrowed = true }), /^Error: issue1503_ci_auth_runtime_failed$/)
    assert.equal(borrowed, false)
  }
})

test('post-unseal health rejects an ended or aborted transaction without another query', async () => {
  const app = pristinePool(), workspace = pristinePool()
  const healthy = protectCiCredentialPools(app, workspace)
  let calls = 0
  const client = guardedClient(async () => { calls += 1; return { rows: [{ transaction_read_only: 'on' }] } })
  await checkout(app, client); healthy()
  for (const status of ['I', 'E', null]) {
    client.status = status
    assert.throws(healthy, /^Error: issue1503_ci_auth_runtime_failed$/)
  }
  assert.equal(calls, 2)
})

test('sticky ErrorResponse closes the old-T and Kysely no-error release race', async () => {
  const app = pristinePool(), workspace = pristinePool()
  const healthy = protectCiCredentialPools(app, workspace)
  const client = guardedClient(async () => ({ rows: [{ transaction_read_only: 'on' }] }))
  await checkout(app, client); healthy()
  const first = new Error('private-first-server-error')
  client.connection.emit('errorMessage', first)
  app.emit('release', undefined, client)
  assert.equal(client.getTransactionStatus(), 'T')
  client.emit('error', new Error('private-later-client-error'))
  assert.throws(healthy, e => e.message === 'issue1503_ci_auth_runtime_failed' && e.cause === first)
})

test('client and pool release errors also close the runtime without leaking their text', async () => {
  for (const signal of ['client', 'release']) {
    const app = pristinePool(), workspace = pristinePool()
    const healthy = protectCiCredentialPools(app, workspace)
    const client = guardedClient(async () => ({ rows: [{ transaction_read_only: 'on' }] }))
    await checkout(app, client)
    const cause = new Error('private-connection-error')
    if (signal === 'client') client.emit('error', cause)
    else app.emit('release', cause, client)
    assert.throws(healthy, e => e.cause === cause && ciAuthErrorCode(e) === 'issue1503_ci_auth_runtime_failed')
  }
})
