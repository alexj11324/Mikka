import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { rotateGitHubChild, rotationSource, rotationLifetime } from './rotate-github-token.mjs'
import { createRotationStore } from './rotate-github-token-store.mjs'
import { SMOKE_USER_ID, OWNER_USER_ID, GITHUB_ACCOUNT_ID, GITHUB_LOGIN, REPOSITORY } from '../issue1503-smoke-github.mjs'

const NOW = Date.parse('2026-11-07T01:00:00Z')
const SOURCE = 'synthetic-unchanged-owner-token', OLD = 'synthetic-old-child', NEW = 'synthetic-new-child', SECRET = 'synthetic-app-secret'
const hash = value => createHash('sha256').update(value).digest('hex')
const iso = time => new Date(time).toISOString()
const permissions = { metadata: 'read', contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read' }
const person = { id: Number(GITHUB_ACCOUNT_ID), login: GITHUB_LOGIN, type: 'User' }
const repo = { id: 1436202099, full_name: REPOSITORY, permissions: { push: true }, archived: false }
const installation = { id: 173164679, app_id: 4840908, client_id: 'fixture-client', account: person, suspended_at: null }
const state = { version: 1, issue: 1503, userId: SMOKE_USER_ID, ownerUserId: OWNER_USER_ID,
  githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN, repository: REPOSITORY,
  appId: '4840908', repositoryId: String(repo.id), installationId: String(installation.id),
  listedRepositoryCount: 1, otherRepositoryMetadataCount: 0, checkTokenScopeConfirmed: false,
  providerExpiresAt: '2026-11-07T02:21:59.000Z', connectionExpiresAt: '2026-11-07T02:21:48.448Z',
  connectionUpdatedAt: '2026-11-06T23:07:50.448Z', tokenSha256: hash(OLD) }
const fixture = { issue: 1503, workspaceId: '93f38d33-9447-4eaf-8a46-0d8889165bcd',
  ownerUserId: OWNER_USER_ID, smokeUserId: SMOKE_USER_ID, githubSetup: state }
const metadata = { userId: OWNER_USER_ID, githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN,
  updatedAt: '2026-11-06T17:47:53.104Z', expiresAt: '2026-11-07T01:47:53.103Z', hasRefreshToken: true }
const source = { token: SOURCE, githubAccountId: GITHUB_ACCOUNT_ID, expiresAt: metadata.expiresAt, metadata }
const idle = { activeRuns: 0, pendingFactoryTasks: 0, pendingSubagents: 0, coordinatorLeases: 0,
  pendingPublications: 0, pendingMerges: 0, activeThreadMachines: 0, activeCloudMachines: 0 }

function scenario(options = {}) {
  let current = { kind: 'old' }, lastMint, time = NOW, cleanupAttempted = false
  const events = [], revoked = [], checkpoints = []
  const store = {
    validateFixture: async () => {}, idle: async () => ({ ...idle }), matching: async () => {},
    ownerSourceNoRefresh: async () => ({ ...source, ...(options.source ?? {}) }),
    ownerMetadata: async () => ({ ...metadata }),
    replace: async (before, originalSource, prepared, hooks) => {
      events.push('locked')
      if (options.casConflict) throw new Error('issue1503_github_rotation_old_child_changed')
      if (options.activeAtSave) throw new Error('issue1503_github_rotation_smoke_work_active')
      await hooks.beforeRevoke(idle)
      await hooks.revokeOld(OLD)
      if (options.saveFailure) throw new Error('SQL bound parameter=' + NEW)
      const after = { ...before, ...prepared.metadata, tokenSha256: prepared.tokenSha256,
        connectionUpdatedAt: iso(NOW), connectionExpiresAt: iso(NOW + 4 * 60 * 60_000 - 10_000) }
      await hooks.prepared(after)
      events.push('save'); current = { kind: 'new', state: after }
      if (options.commitUnclear) throw new Error('commit socket ' + NEW)
      return after
    },
    observe: async () => {
      events.push('observe')
      if (options.readbackUnavailable) throw Error('connection lost')
      return current
    },
  }
  const fetchImpl = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.github.com')
    assert.notEqual(new URL(url).pathname, '/login/oauth/access_token', 'must never refresh Owner')
    assert.ok(!String(url).includes('/grant'))
    const path = new URL(url).pathname, token = init.body ? JSON.parse(init.body).access_token : null
    if (init.method === 'DELETE') {
      cleanupAttempted = true
      assert.ok([OLD, NEW].includes(token)); assert.notEqual(token, SOURCE)
      events.push('revoke_' + (token === OLD ? 'old' : 'new'))
      if (token === OLD && options.oldDeleteFailure) return Response.json({ message: SECRET }, { status: 500 })
      if (token === NEW && options.newDeleteFailure) return Response.json({ message: SECRET }, { status: 500 })
      revoked.push(token); return new Response(null, { status: 204 })
    }
    if (path.endsWith('/token/scoped')) {
      events.push('mint'); lastMint = JSON.parse(init.body)
      assert.deepEqual(lastMint, { access_token: SOURCE, target: GITHUB_LOGIN, repositories: ['Mikka-handoff'], permissions })
      if (options.exceedDeadline) time += 5 * 60_000 + 1
      return Response.json({ token: options.sameAsOld ? OLD : NEW,
        expires_at: iso(NOW + (options.shortChild ? 60 : 480) * 60_000), app: { client_id: 'fixture-client' }, user: person,
        installation: { repository_selection: options.wideScope ? 'all' : 'selected', permissions } })
    }
    if (path.endsWith('/token')) {
      if (token === OLD) return options.oldInvalid ? Response.json({ message: 'Not Found' }, { status: 404 })
        : Response.json({ app: { client_id: 'fixture-client' }, token: OLD })
      if (token === NEW && options.newDeleteFailure && cleanupAttempted) return Response.json({ token: NEW })
      if (token === SOURCE && 'sourceProviderExpiry' in options) return Response.json({ app: { client_id: 'fixture-client' }, token,
        expires_at: options.sourceProviderExpiry, user: person })
      return Response.json({ app: { client_id: 'fixture-client' }, token, expires_at: iso(NOW + 480 * 60_000), user: person })
    }
    if (path === '/user') return Response.json(person)
    if (path === '/repos/' + REPOSITORY) return Response.json(repo)
    if (path === '/user/installations') return Response.json({ installations: [installation] })
    if (path.endsWith('/repositories')) return Response.json({ repositories: [repo] })
    assert.fail('unexpected provider request')
  }
  return { events, revoked, checkpoints, get current() { return current },
    run: () => rotateGitHubChild({ fixture, application: { clientId: 'fixture-client', clientSecret: SECRET },
      appId: '4840908', store, fetchImpl, now: () => time,
      checkpoint: async value => { checkpoints.push(JSON.parse(JSON.stringify(value))) } }) }
}

test('a genuinely short-lived Owner source mints a fresh scoped child without refreshing Owner', async () => {
  const f = scenario(), r = await f.run()
  assert.equal(r.status, 'passed'); assert.equal(r.ownerUnchanged, true)
  assert.deepEqual(r.ownerBefore, metadata); assert.deepEqual(r.ownerAfter, metadata)
  assert.deepEqual(r.ownerProvider, { providerExpiresAt: iso(NOW + 8 * 60 * 60_000), checkedAt: iso(NOW) })
  assert.ok(Date.parse(metadata.expiresAt) < NOW + 4 * 60 * 60_000)
  assert.equal(r.after.providerExpiresAt, iso(NOW + 8 * 60 * 60_000))
  assert.equal(r.after.tokenSha256, hash(NEW)); assert.equal(r.after.checkTokenScopeConfirmed, false)
  assert.deepEqual(f.revoked, [OLD]); assert.ok(f.events.indexOf('mint') < f.events.indexOf('locked'))
  assert.ok(f.events.indexOf('revoke_old') < f.events.indexOf('save'))
  for (const secret of [SOURCE, OLD, NEW, SECRET]) assert.ok(!JSON.stringify(f.checkpoints).includes(secret))
})

test('the real checked Owner provider expiry must independently exceed ten minutes before mint', async () => {
  for (const sourceProviderExpiry of [null, 'invalid', iso(NOW + 600_000)]) {
    const f = scenario({ sourceProviderExpiry }), r = await f.run()
    assert.equal(r.code, 'issue1503_github_owner_provider_expiry_invalid')
    assert.equal(f.events.includes('mint'), false); assert.deepEqual(f.revoked, [])
    assert.equal(f.current.kind, 'old')
  }
})

test('source minimum is real and strict; unknown/expired/wrong-owner sources fail without provider I/O', async () => {
  for (const expiresAt of [null, 'invalid', iso(NOW), iso(NOW + 600_000)]) {
    const f = scenario({ source: { expiresAt, metadata: { ...metadata, expiresAt } } }), r = await f.run()
    assert.equal(r.code, 'issue1503_github_rotation_owner_source_not_fresh'); assert.deepEqual(f.events, [])
  }
  assert.throws(() => rotationSource({ ...source, metadata: { ...metadata, userId: SMOKE_USER_ID } }, NOW), /owner_source_not_fresh/)
  assert.throws(() => rotationLifetime(NOW + 2 * 60 * 60_000, NOW), /child_validity_insufficient/)
})

for (const [name, options] of [['short provider expiry', { shortChild: true }], ['broader scope', { wideScope: true }],
  ['bounded preparation expired', { exceedDeadline: true }]]) {
  test(`${name} revokes only the new child and retains the original exact connection`, async () => {
    const f = scenario(options), r = await f.run()
    assert.equal(r.status, 'incomplete'); assert.deepEqual(f.revoked, [NEW]); assert.equal(f.current.kind, 'old')
    assert.equal(f.events.includes('revoke_old'), false); assert.equal(r.installAttempted, false)
  })
}

test('a provider response reusing the old child cannot revoke the old child as failed-new cleanup', async () => {
  const f = scenario({ sameAsOld: true }), r = await f.run()
  assert.equal(r.code, 'issue1503_github_rotation_child_not_distinct'); assert.deepEqual(f.revoked, [])
})

for (const [name, options] of [['old CAS conflict', { casConflict: true }], ['new concurrent Smoke work', { activeAtSave: true }]]) {
  test(`${name} preserves the original connection and never revokes it`, async () => {
    const f = scenario(options), r = await f.run()
    assert.equal(r.status, 'incomplete'); assert.deepEqual(f.revoked, [NEW]); assert.equal(f.current.kind, 'old')
    assert.equal(r.recovery, 'old_connection_retained')
  })
}

test('unconfirmed old revocation leaves the old row and cleans the new child', async () => {
  const f = scenario({ oldDeleteFailure: true }), r = await f.run()
  assert.equal(r.status, 'incomplete'); assert.equal(r.oldChildRevocation, undefined)
  assert.equal(f.current.kind, 'old'); assert.deepEqual(f.revoked, [NEW])
})

test('authenticated old-token 404 allows recovery after an earlier confirmed revoke/save failure', async () => {
  const f = scenario({ oldDeleteFailure: true, oldInvalid: true }), r = await f.run()
  assert.equal(r.status, 'passed'); assert.deepEqual(r.oldChildRevocation, { kind: 'authenticated_check_token', status: 404 })
  assert.equal(f.current.kind, 'new'); assert.deepEqual(f.revoked, [])
})

test('a save failure after old revocation is honest and recoverable from the retained exact old row', async () => {
  const f = scenario({ saveFailure: true }), r = await f.run()
  assert.equal(r.status, 'incomplete'); assert.equal(r.changed, false); assert.equal(r.oldConnectionUsable, false)
  assert.equal(r.recovery, 'mint_again_against_revoked_old_cas'); assert.equal(f.current.kind, 'old')
  assert.deepEqual(f.revoked, [OLD, NEW]); assert.ok(!JSON.stringify(r).includes(NEW))
})

test('a lost COMMIT acknowledgement never revokes a new token confirmed in the database', async () => {
  const f = scenario({ commitUnclear: true }), r = await f.run()
  assert.equal(r.status, 'incomplete'); assert.equal(r.changed, true); assert.equal(r.commitObservation, 'new')
  assert.equal(r.after.tokenSha256, hash(NEW)); assert.deepEqual(f.revoked, [OLD])
  assert.ok(f.checkpoints.at(-1).after)
})

test('unavailable commit readback preserves a possibly installed token and reports uncertainty', async () => {
  const f = scenario({ commitUnclear: true, readbackUnavailable: true }), r = await f.run()
  assert.equal(r.status, 'incomplete'); assert.equal(r.commitUnconfirmed, true)
  assert.deepEqual(f.revoked, [OLD]); assert.equal(r.preparedAfter.tokenSha256, hash(NEW))
})

test('new-token cleanup failure exposes only a code and actual provider expiry, never secret material', async () => {
  const f = scenario({ casConflict: true, newDeleteFailure: true }), r = await f.run()
  assert.equal(r.newChildCleanup.confirmed, false)
  assert.equal(r.newChildCleanup.tokenSha256, hash(NEW))
  assert.equal(r.newChildCleanup.providerExpiresAt, iso(NOW + 8 * 60 * 60_000))
  for (const secret of [SOURCE, OLD, NEW, SECRET]) assert.ok(!JSON.stringify(r).includes(secret))
})

test('an unvalidated new child still has a safe hash receipt when its revocation cannot be confirmed', async () => {
  const f = scenario({ wideScope: true, newDeleteFailure: true }), r = await f.run()
  assert.equal(r.status, 'incomplete'); assert.equal(r.installAttempted, false)
  assert.equal(r.newChildCleanup.confirmed, false)
  assert.equal(r.newChildCleanup.tokenSha256, hash(NEW)); assert.equal(r.newChildCleanup.providerExpiresAt, null)
  assert.equal(f.current.kind, 'old')
  for (const secret of [SOURCE, OLD, NEW, SECRET]) assert.ok(!JSON.stringify(r).includes(secret))
})

test('store releases a failed transaction before lock-reading an ambiguous commit on a fresh client', async () => {
  const events = [], oldRow = { userId: SMOKE_USER_ID, githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN,
    accessToken: 'sealed-old', hasRefreshToken: false, refreshTokenExpiresAt: null,
    updatedAt: new Date(state.connectionUpdatedAt), accessTokenExpiresAt: new Date(state.connectionExpiresAt) }
  const ownerRow = { userId: OWNER_USER_ID, githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN,
    accessToken: 'sealed-source', hasRefreshToken: true, updatedAt: new Date(metadata.updatedAt), accessTokenExpiresAt: new Date(metadata.expiresAt) }
  let row = oldRow, connections = 0
  const pool = { connect: async () => {
    const n = ++connections
    return { query: async (input, values) => {
      const text = typeof input === 'string' ? input : input.text
      events.push(`${n}:${text.split('\n')[0]}`)
      if (text.includes('FROM github_connections')) {
        if (values[0] === OWNER_USER_ID) return { rows: [ownerRow] }
        if (n === 2) assert.ok(text.endsWith('FOR UPDATE'), 'readback must wait for original transaction settlement')
        return { rows: [row] }
      }
      if (text.includes('count(*)')) return { rows: [idle] }
      if (text === 'COMMIT' && n === 1) throw Error('lost commit acknowledgement')
      return { rows: [] }
    }, release: destroyed => { events.push(`${n}:release:${destroyed}`) } }
  } }
  const connection = {
    unsealGitHubSecret: async value => ({ 'sealed-old': OLD, 'sealed-source': SOURCE, 'sealed-new': NEW })[value],
    saveGitHubConnection: async (userId, identity, token) => {
      assert.equal(userId, SMOKE_USER_ID); assert.equal(token.access_token, NEW)
      row = { ...oldRow, accessToken: 'sealed-new', updatedAt: new Date(NOW), accessTokenExpiresAt: new Date(NOW + token.expires_in * 1000) }
      events.push('normal-save')
    },
  }
  const store = createRotationStore({ pool, workspacePool: {}, withDatabaseClient: (_, fn) => fn(), connection,
    now: () => NOW, lifetime: rotationLifetime })
  const prepared = { token: NEW, tokenSha256: hash(NEW), providerExpiry: NOW + 8 * 60 * 60_000,
    metadata: { ...state, providerExpiresAt: iso(NOW + 8 * 60 * 60_000) } }
  await assert.rejects(store.replace(state, { ...source, sealedFingerprint: hash('sealed-source') }, prepared, {
    beforeRevoke: async () => {}, revokeOld: async token => { assert.equal(token, OLD); events.push('revoke-old') }, prepared: async () => {},
  }))
  assert.equal((await store.observe(state, prepared)).kind, 'new')
  assert.ok(events.indexOf('revoke-old') < events.indexOf('normal-save'))
  assert.ok(events.indexOf('1:ROLLBACK') < events.indexOf('1:release:true'))
  assert.ok(events.indexOf('1:release:true') < events.indexOf('2:BEGIN'))
})
