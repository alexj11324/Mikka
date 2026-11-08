import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ciAuthErrorCode, ciCredentialSelect, loadCiGithubToken } from './ci-github-token.mjs'
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
