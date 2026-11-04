import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runGroupRoutingBundle } from './group-routing-bundle.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const digest = text => createHash('sha256').update(text).digest('hex')
const revision = 'a'.repeat(40), deploymentId = 'dpl_SyntheticOnly', origin = 'https://app.aspectlylabs.com'
const ownerId = 'synthetic-owner', email = 'synthetic-smoke@example.invalid'
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers })
function fixture(options = {}) {
  let clock = Date.parse('2026-11-04T00:00:00Z')
  const state = { requests: [], helperCalls: 0, groupCalls: 0, logouts: 0, discoveries: 0, cleanupSegments: [], sequence: [],
    cleanup: { created: !options.existingKey, removed: false } }
  const group = { status: 'pass', revision, deploymentId, conversationId: id(1), fixtureId: id(2), workspaceId: id(3), requesterId: ownerId,
    startedAt: new Date(clock).toISOString(), bots: ['UI', 'Coding', 'Testing'].map((role, i) => ({ id: id(i + 4), role, modelId: 'deepseek-flash' })) }
  const core = { status: 'pass', group, origin, revision, deploymentId, fixtureConversationId: group.conversationId,
    replay: { status: 'complete' }, replayAccounting: { qualityAccepted: true, collectionComplete: true },
    expectedDecisionReplays: 24, actualReceiptedDecisionReplays: 24, completedLogicalDecisionReplays: 24,
    notProjected: 'PRIVATE_CORE_SENTINEL' }
  const env = { GROUP_ACCEPTANCE_REVISION: revision, GROUP_ACCEPTANCE_DEPLOYMENT: deploymentId,
    SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: 'PRIVATE_PASSWORD', DEEPSEEK_API_KEY: 'PRIVATE_FLASH' }
  const fetchImpl = async (url, init = {}) => {
    assert.equal(url.origin, origin); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal)
    clock++; const path = url.pathname.replace(/^\/mikka/, '')
    state.requests.push({ path, method: init.method ?? 'GET' })
    if (path === '/api/version') {
      if (options.exhaustWork && state.groupReturned) { clock += 15_000; state.cleanupSegments.push('final-version') }
      return response({ build: options.wrongBuild || options.driftAfterGroup && state.groupReturned ? 'dpl_Changed' : deploymentId })
    }
    if (path === '/en' && init.method === 'GET') return response({ publicPage: true })
    if (path === '/_next/static/chunks/credentials.js') return response({ publicAsset: true })
    if (path === '/en' && init.method === 'POST') {
      const action = new Headers(init.headers).get('next-action')
      assert.ok([digest('create'), digest('delete')].includes(action))
      if (action === digest('delete')) {
        state.sequence.push('delete-action')
        if (options.exhaustWork) { clock += 15_000; state.cleanupSegments.push('delete-key') }
        if (options.unknownDelete) throw Error('PRIVATE_DELETE_OUTCOME_UNKNOWN')
        return response({ removed: true }, options.staleDeleteReference ? 404 : options.keyCleanupFailure ? 503 : 200)
      }
      state.sequence.push('create-action'); return response({ id: id(90), provider: 'deepseek' })
    }
    if (path === '/api/auth/sign-in/email') {
      state.sequence.push('login'); return response({ ok: true }, 200, { 'set-cookie': 'session=PRIVATE_COOKIE; HttpOnly' })
    }
    if (path === '/api/auth/get-session') {
      assert.ok(new Headers(init.headers).get('cookie')?.includes('PRIVATE_COOKIE'))
      state.sequence.push('owner-verified')
      return response({ user: { id: options.foreignOwner ? 'foreign-owner' : ownerId, email } })
    }
    if (path === '/api/auth/sign-out') {
      state.logouts++; state.sequence.push('logout')
      if (options.exhaustWork && state.groupReturned) { clock += 15_000; state.cleanupSegments.push(state.logouts === 1 ? 'helper-logout' : 'owner-logout') }
      if (options.unknownLogout) throw Error('PRIVATE_UPSTREAM_CREDENTIAL')
      return response({ ok: true }, options.logoutFailure ? 503 : 200)
    }
    assert.fail('Unexpected endpoint')
  }
  const dependencies = { isSmokeAccountEmail: value => value === email,
    assertFlashTestModel: value => assert.equal(value, 'deepseek-flash'), DECISION_MODEL: 'openai/gpt-6-luna-decisions',
    publicCredentialActions: async (fetcher, names) => {
      state.discoveries++; assert.deepEqual(names, ['createApiKey', 'deleteApiKey'])
      assert.equal(state.groupCalls, 0, 'Resolve both references before routing and key creation')
      await fetcher(origin + '/mikka/en', { method: 'GET' })
      await fetcher(origin + '/mikka/_next/static/chunks/credentials.js', { method: 'GET' })
      return { createApiKey: digest('create'), deleteApiKey: digest('delete') }
    },
    withTemporaryFlashCredential: async (work, config) => {
      state.helperCalls++; state.sequence.push('helper')
      assert.equal(config.cloudExecution, false); assert.equal(config.env.MIKKA_TEST_ACCOUNT_EMAIL, email)
      assert.equal(config.env.MIKKA_TEST_ACCOUNT_PASSWORD, env.SMOKE_OWNER_PASSWORD)
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
      if (options.foreignTransport) { await config.fetchImpl('https://foreign.invalid/mikka/api/auth/sign-in/email', init); assert.fail('Foreign request accepted') }
      await config.fetchImpl(origin + '/mikka/api/auth/sign-in/email', init)
      try {
        if (!options.existingKey) {
          const actions = await config.discover(config.fetchImpl, ['createApiKey'])
          await config.fetchImpl(origin + '/mikka/en', { ...init, headers: { ...init.headers, 'next-action': actions.createApiKey } })
        }
        return await work(state.cleanup)
      }
      finally {
        try {
          if (!options.existingKey) {
            state.sequence.push('key-cleanup')
            const actions = await config.discover(config.fetchImpl, ['deleteApiKey'])
            const result = await config.fetchImpl(origin + '/mikka/en', { ...init, headers: { ...init.headers, 'next-action': actions.deleteApiKey } })
            state.cleanup.removed = result.status === 200
            if (!state.cleanup.removed) throw Error('PRIVATE_DELETE_ERROR')
          }
        } finally {
          try { await config.fetchImpl(origin + '/mikka/api/auth/sign-out', init) } catch { /* Mirrors the real helper's safe logout capture. */ }
        }
      }
    },
    runGroupRoutingBoundaries: async input => {
      state.groupCalls++; state.sequence.push('group')
      assert.equal(input.allowFixtureFlashSelection, true); assert.equal(input.decisionModelId, 'openai/gpt-6-luna-decisions')
      assert.equal(input.fixture.exclusive, true); assert.equal(input.fixture.coreBundleStatus, 'pass')
      assert.equal(input.fixture.reportSha256, digest(JSON.stringify(group))); assert.deepEqual(input.fixture.sourcePin, { revision, deploymentId })
      state.moduleBudget = input.budgetMs
      assert.ok(input.budgetMs <= 555_000 && input.budgetMs >= 1000)
      await input.verifyTarget(); input.assertFlashTestModel('deepseek-flash')
      await input.owner.request('/api/auth/get-session', { method: 'GET' })
      if (options.exhaustWork) clock += input.budgetMs
      state.groupReturned = true
      return { status: options.groupFailure ? 'failed' : 'passed', conversationId: group.conversationId,
        callerSessionAndCredentialCleanupRequired: true, providerCalls: { receipted: 1, complete: false },
        knownCostUsd: 0.00001, completeCostUsd: null, cleanup: { group: { acknowledged: true, noPendingRetry: true } } }
    } }
  const args = { env, fetchImpl, dependencies, now: () => clock, wait: async ms => { clock += ms },
    verifySource: () => options.wrongSource ? 'b'.repeat(40) : revision }
  const input = () => { const coreReportJson = JSON.stringify(core, null, 2) + '\n'; return { ...args, coreReportJson, coreReportSha256: digest(coreReportJson) } }
  return { state, core, group, args, input }
}

test('the inert adapter binds actual artifact bytes, source and owner before the normal Flash helper, then requires both logouts', async () => {
  const h = fixture(), report = await runGroupRoutingBundle(h.input())
  assert.equal(report.status, 'passed'); assert.equal(h.state.helperCalls, 1); assert.equal(h.state.groupCalls, 1)
  assert.ok(h.state.sequence.indexOf('owner-verified') < h.state.sequence.indexOf('helper'))
  assert.ok(h.state.sequence.indexOf('group') < h.state.sequence.indexOf('key-cleanup'))
  assert.equal(h.state.logouts, 2); assert.equal(report.cloudCredentialCreated, false)
  assert.equal(h.state.discoveries, 1)
  assert.ok(h.state.moduleBudget <= 535_000)
  assert.equal(report.coreEvidence.artifactProvenanceVerifiedByRunner, false)
  assert.deepEqual(report.credentialCleanup, { created: true, removed: true })
  assert.ok(Object.values(report.sessionCleanup).every(row => row.loginStatus === 200 && row.logoutStatus === 200))
  for (const value of ['PRIVATE', email, 'password', 'cookie']) assert.equal(JSON.stringify(report).includes(value), false)
})

test('failed, partial, wrong-source or mismatched-byte core reports stop before any login, credential or prompt request', async () => {
  const changes = [core => { core.status = 'fail' }, core => { core.group.status = 'fail' },
    core => { core.replayAccounting.qualityAccepted = false }, core => { core.replayAccounting.collectionComplete = false },
    core => { core.actualReceiptedDecisionReplays = 1 }, core => { core.completedLogicalDecisionReplays = 23 },
    core => { core.revision = 'b'.repeat(40) }, core => { core.group.deploymentId = 'dpl_Old' },
    core => { core.fixtureConversationId = id(90) }]
  for (const change of changes) {
    const h = fixture(); change(h.core)
    await assert.rejects(runGroupRoutingBundle(h.input()), /routing_bundle_/)
    assert.equal(h.state.requests.length, 0); assert.equal(h.state.helperCalls, 0)
  }
  const h = fixture(), input = h.input(); input.coreReportJson += ' '
  await assert.rejects(runGroupRoutingBundle(input), /core_artifact_digest/); assert.equal(h.state.requests.length, 0)
})

test('a wrong checkout, changed deployment or foreign session cannot enter the temporary credential or routing operation', async () => {
  const source = fixture({ wrongSource: true })
  await assert.rejects(runGroupRoutingBundle(source.input()), /source_revision_mismatch/); assert.equal(source.state.requests.length, 0)
  for (const options of [{ wrongBuild: true }, { foreignOwner: true }]) {
    const h = fixture(options), report = await runGroupRoutingBundle(h.input())
    assert.equal(report.status, 'failed'); assert.equal(h.state.helperCalls, 0); assert.equal(h.state.groupCalls, 0)
    if (options.foreignOwner) assert.equal(h.state.logouts, 1)
  }
})

test('group failure or post-run deployment drift still removes the new key and logs out both normal sessions', async () => {
  for (const options of [{ groupFailure: true }, { driftAfterGroup: true }]) {
    const h = fixture(options), report = await runGroupRoutingBundle(h.input())
    assert.equal(report.status, 'failed'); assert.equal(h.state.groupCalls, 1); assert.equal(h.state.logouts, 2)
    assert.equal(report.credentialCleanup.removed, true); assert.equal(report.group.knownCostUsd, 0.00001)
    assert.equal(report.group.completeCostUsd, null)
  }
})

test('failed or unknown key/session cleanup never passes and no logout mutation is replayed', async () => {
  for (const options of [{ keyCleanupFailure: true }, { logoutFailure: true }, { unknownLogout: true }]) {
    const h = fixture(options), report = await runGroupRoutingBundle(h.input())
    assert.equal(report.status, 'failed'); assert.equal(h.state.groupCalls, 1); assert.equal(h.state.logouts, 2)
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false)
    if (options.unknownLogout) assert.ok(Object.values(report.sessionCleanup).every(row => row.logoutAttempted && !row.logoutAcknowledged && row.logoutStatus === null))
  }
})

test('the total ten-minute budget reserves65s for the four15s cleanup requests with no action rediscovery', async () => {
  const h = fixture({ exhaustWork: true }), report = await runGroupRoutingBundle(h.input())
  assert.equal(report.status, 'passed'); assert.ok(report.elapsedMs < 600_000); assert.ok(report.elapsedMs >= 595_000)
  assert.deepEqual(h.state.cleanupSegments, ['delete-key', 'helper-logout', 'final-version', 'owner-logout'])
  assert.equal(h.state.discoveries, 1)
  assert.equal(h.state.logouts, 2); assert.equal(report.credentialCleanup.removed, true)
})

test('an existing Flash key is preserved without resolving or writing credential actions', async () => {
  const h = fixture({ existingKey: true }), report = await runGroupRoutingBundle(h.input())
  assert.equal(report.status, 'passed'); assert.equal(h.state.discoveries, 0)
  assert.equal(h.state.requests.some(row => row.path === '/en'), false)
  assert.deepEqual(report.credentialCleanup, { created: false, removed: false }); assert.equal(h.state.logouts, 2)
})

test('a stale cached deletion reference or unknown delete stays failed without rediscovery or replay and still attempts both logouts', async () => {
  for (const options of [{ staleDeleteReference: true }, { unknownDelete: true }]) {
    const h = fixture(options), report = await runGroupRoutingBundle(h.input())
    assert.equal(report.status, 'failed'); assert.equal(h.state.discoveries, 1)
    assert.equal(h.state.sequence.filter(step => step === 'delete-action').length, 1)
    assert.equal(report.credentialCleanup.created, true); assert.equal(report.credentialCleanup.removed, false)
    assert.equal(h.state.logouts, 2); assert.equal(h.state.groupCalls, 1)
    assert.ok(Object.values(report.sessionCleanup).every(row => row.logoutStatus === 200))
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false)
  }
})

test('credential transport cannot send the session or secret inputs to another origin', async () => {
  const h = fixture({ foreignTransport: true }), report = await runGroupRoutingBundle(h.input())
  assert.equal(report.status, 'failed'); assert.equal(report.error, 'routing_bundle_transport_origin_rejected')
  assert.equal(h.state.groupCalls, 0); assert.equal(h.state.logouts, 1)
})
