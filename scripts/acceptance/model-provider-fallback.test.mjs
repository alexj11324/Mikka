import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AcceptanceError, CASES, ORIGIN, REPOSITORY, actionResult, assertRunEvidence, assertVersion, caseOrderPlan, deleteFixtureArtifact,
  independently, mergeGuard, orderFingerprint, ownedSource, providerReceipt, publicFailure, runModelProviderAcceptance, verifyCheckRuns,
} from './model-provider-fallback.mjs'

const SHA = 'a'.repeat(40)
const OWNER = 'acceptance-owner'
const WS = '10000000-0000-4000-8000-000000000001'
const BOT = '10000000-0000-4000-8000-000000000002'
const ISSUE = '10000000-0000-4000-8000-000000000003'
const RUN = '10000000-0000-4000-8000-000000000004'
const KEY = '10000000-0000-4000-8000-000000000005'
const CLAUDE = '10000000-0000-4000-8000-000000000006'
const CODEX = '10000000-0000-4000-8000-000000000007'
const BINDING = '10000000-0000-4000-8000-000000000008'
const actionNames = ['getIssueThread', 'changeModelOrder', 'getIssue', 'setIssueDeleted', 'getDeletedIssue', 'getArtifact']
const refs = Object.fromEntries(actionNames.map((name, index) => [name, String(index + 1).repeat(40)]))
const pr = () => ({ number: 1232, merged: true, merge_commit_sha: SHA, body: 'Refs #1225', base: { ref: 'main', repo: { full_name: REPOSITORY } } })
const deployed = () => ({ name: 'Web deploy', status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: SHA,
  head_repository: { full_name: REPOSITORY }, head_commit: { message: 'Handle provider failures (#1232)' } })
const guard = () => ({ repository: REPOSITORY, ref: 'refs/heads/main', eventName: 'workflow_run', event: { workflow_run: deployed() }, pr: pr() })

test('only the exact merged PR 1232 deploy authorizes automatic active acceptance', () => {
  assert.deepEqual(mergeGuard(guard()), { sha: SHA, mode: 'active' })
  assert.deepEqual(mergeGuard({ ...guard(), eventName: 'workflow_dispatch', event: {} }), { sha: SHA, mode: 'preflight' })
  assert.deepEqual(mergeGuard({ ...guard(), event: { workflow_run: { ...deployed(), head_commit: { message: 'merge' }, pull_requests: [{ number: 1232 }] } } }), { sha: SHA, mode: 'active' })
  for (const changed of [
    { repository: 'another/Mikka' }, { ref: 'refs/pull/1232/merge' }, { eventName: 'pull_request' },
    { pr: { ...pr(), number: 1225 } }, { pr: { ...pr(), merged: false } }, { pr: { ...pr(), body: 'Refs #1233' } },
    { event: { workflow_run: { ...deployed(), head_sha: 'b'.repeat(40) } } },
    { event: { workflow_run: { ...deployed(), conclusion: 'failure' } } },
    { event: { workflow_run: { ...deployed(), head_repository: { full_name: 'someone/fork' } } } },
    { event: { workflow_run: { ...deployed(), head_commit: { message: 'Other issue (#1233)' }, pull_requests: [{ number: 1233 }] } } },
  ]) assert.throws(() => mergeGuard({ ...guard(), ...changed }), /merge_scope_rejected/)
})

test('version pin refuses a different revision and an unmapped deployment id', () => {
  assert.doesNotThrow(() => assertVersion(SHA, SHA))
  assert.throws(() => assertVersion('b'.repeat(40), SHA), /build_mismatch/)
  assert.throws(() => assertVersion('dpl_existing', SHA), /build_mapping_required/)
  assert.throws(() => assertVersion(SHA, 'main'), /configuration_required/)
})

function inventory() {
  const candidates = CASES.map((item, index) => ({ harness: item.harness, model: item.model, provider: item.provider,
    credentialOwnerId: OWNER, source: item.kind === 'api_key' ? { kind: item.kind, keyId: KEY } : { kind: item.kind, connectionId: index === 1 ? CLAUDE : CODEX } }))
  const entries = candidates.map((candidate, index) => ({ ...candidate, id: `entry-${index}`, block: null }))
  return { ownerId: OWNER, keys: { keys: [{ id: KEY, provider: 'deepseek' }] },
    connections: { connections: [{ id: CLAUDE, provider: 'claude', state: 'connected', paused: false }, { id: CODEX, provider: 'codex', state: 'connected', paused: false }] },
    order: { location: 'cloud', customized: true, preferredHarness: 'claude_code', cloudReady: true, candidates, entries,
      cloudModels: Object.fromEntries(entries.map(entry => [entry.id, 'ready'])) } }
}

test('source discovery requires the exact small model and an existing own source', () => {
  for (const item of CASES) assert.equal(ownedSource(item, inventory()).model, item.model)
  const shared = inventory()
  shared.order.candidates[0].credentialOwnerId = 'other-member'
  assert.throws(() => ownedSource(CASES[0], shared), /source_missing/)
  const changed = inventory()
  changed.order.candidates[1].model = 'claude-opus'
  assert.throws(() => ownedSource(CASES[1], changed), /source_missing/)
  const absent = inventory()
  absent.keys.keys = []
  assert.throws(() => ownedSource(CASES[0], absent), /source_missing/)
  const stale = inventory()
  stale.order.entries[2].block = { reason: 'quota' }
  assert.throws(() => ownedSource(CASES[2], stale), error => publicFailure(error).block === 'quota')
})

test('the order comparison includes identities, harness, order and location but not changing health projections', () => {
  const before = inventory().order
  const after = structuredClone(before)
  after.entries[0].block = { reason: 'balance' }
  assert.equal(orderFingerprint(before), orderFingerprint(after))
  after.entries.reverse()
  assert.notEqual(orderFingerprint(before), orderFingerprint(after))
  after.entries.reverse(); after.entries[0].source.keyId = CODEX
  assert.notEqual(orderFingerprint(before), orderFingerprint(after))
  after.entries[0].source.keyId = KEY; after.location = 'local'
  assert.notEqual(orderFingerprint(before), orderFingerprint(after))
})

test('every case limits the producer and later Factory selections to its exact own small-model order', () => {
  const state = inventory()
  const opus = { ...state.order.candidates[1], model: 'claude-opus', source: { kind: 'subscription', connectionId: BINDING }, credentialOwnerId: 'other-member' }
  state.order.candidates.push(opus)
  state.order.entries.unshift({ ...opus, id: 'shared-opus', block: null })
  for (const item of CASES.slice(1)) {
    const selected = ownedSource(item, state)
    const plan = caseOrderPlan(state.order, [selected], OWNER)
    assert.equal(plan.already, false)
    assert.deepEqual(plan.wanted.map(entry => [entry.model, entry.credentialOwnerId]), [[item.model, OWNER]])
    assert.throws(() => caseOrderPlan({ ...state.order, customized: false }, [selected], OWNER), /order_restore_unavailable/)
  }
  const first = ownedSource(CASES[0], state), next = ownedSource(CASES[2], state)
  const fallback = caseOrderPlan(state.order, [first, next], OWNER)
  assert.deepEqual(fallback.wanted.map(entry => entry.model), ['deepseek-flash', 'gpt-6-luna'])
  assert.throws(() => caseOrderPlan(state.order, [{ ...next, credentialOwnerId: 'other-member' }], OWNER), /run_identity/)
})

function evidence(item = CASES[1]) {
  const resourceId = item.kind === 'api_key' ? KEY : BINDING
  return { run: { id: RUN, issueId: ISSUE, botId: BOT, status: 'succeeded', model: item.model, harness: item.harness,
    credentialType: item.kind, subscriptionRoute: item.kind === 'api_key' ? null : item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli',
    executionIdentity: { version: 1, requester: OWNER, executionPrincipal: OWNER, outputOwner: OWNER, botId: BOT, botOwner: OWNER,
      workspaceId: WS, personalResourcePolicy: 'requester_only',
      resourceBindings: [{ kind: item.kind, id: resourceId, ownerId: OWNER, access: 'owner' }],
      billingAccount: { model: { kind: item.kind, ownerId: OWNER, resourceId }, runtime: { kind: 'e2b', ownerId: OWNER } } } }, artifacts: [] }
}
const scope = (item = CASES[1]) => ({ ownerId: OWNER, workspaceId: WS, botId: BOT, issueId: ISSUE, model: item.model, harness: item.harness, kind: item.kind, keyId: KEY })

test('frozen execution evidence must match owner, workspace, bot, model and official CLI route', () => {
  for (const item of CASES) assert.equal(assertRunEvidence(evidence(item), scope(item)).model, item.model)
  for (const mutate of [
    value => { value.run.botId = CODEX }, value => { value.run.issueId = CODEX },
    value => { value.run.model = 'claude-opus' }, value => { value.run.subscriptionRoute = 'openai_siwc' },
    value => { value.run.credentialType = 'api_key' },
    value => { value.run.executionIdentity.workspaceId = CODEX },
    value => { value.run.executionIdentity.requester = 'other-user' },
    value => { value.run.executionIdentity.billingAccount.model.ownerId = 'other-user' },
    value => { value.run.executionIdentity.resourceBindings[0].access = 'workspace_share' },
    value => { value.run.executionIdentity.billingAccount.runtime.ownerId = 'other-user' },
  ]) { const value = evidence(); mutate(value); assert.throws(() => assertRunEvidence(value, scope())) }
  const wrongKey = evidence(CASES[0]); wrongKey.run.executionIdentity.billingAccount.model.resourceId = CODEX
  assert.throws(() => assertRunEvidence(wrongKey, scope(CASES[0])), /run_identity/)
})

test('passed review and verify receipts still require actual small-model, own-source and native-route evidence', async () => {
  const checks = [{ stage: 'review', runId: RUN }, { stage: 'verify', runId: KEY }]
  for (const item of CASES.slice(1)) {
    const read = async runId => { const found = evidence(item); found.run.id = runId; return found }
    const accepted = await verifyCheckRuns(checks, scope(item), read)
    assert.deepEqual(accepted.map(check => [check.stage, check.model, check.subscriptionRoute]),
      checks.map(check => [check.stage, item.model, item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli']))
    for (const mutate of [
      found => { found.run.model = item.harness === 'codex' ? 'gpt-other' : 'claude-opus' },
      found => { found.run.credentialType = 'api_key'; found.run.subscriptionRoute = null },
      found => { found.run.subscriptionRoute = 'openai_siwc' },
      found => { found.run.executionIdentity.billingAccount.model.ownerId = 'shared-owner' },
      found => { found.run.executionIdentity.resourceBindings[0].access = 'workspace_share' },
      found => { found.run.executionIdentity.workspaceId = CODEX },
    ]) await assert.rejects(verifyCheckRuns(checks, scope(item), async runId => {
      const found = await read(runId)
      if (runId === KEY) mutate(found)
      return found
    }))
  }
})

test('artifact cleanup retains an earlier task artifact even when this run submitted its newest version', async () => {
  const id = '10000000-0000-4000-8000-000000000009'
  const scope = { runIds: new Set([RUN]), issueIds: new Set([ISSUE]), botId: BOT }
  const own = { id, runId: RUN, issueId: ISSUE, botId: BOT, versions: [{ version: 1 }, { version: 2 }], latestVersion: 2 }
  let deletes = 0
  const remove = async artifactId => { assert.equal(artifactId, id); deletes++; return { status: 204 } }
  // Current-run submissions can point at version 2, but detail retains the
  // original creator. A matching title or a new timestamp grants no deletion.
  for (const different of [
    { ...own, runId: CODEX, title: 'the requested acceptance filename' },
    { ...own, issueId: CODEX }, { ...own, botId: CODEX }, { ...own, runId: null },
    { ...own, id: CODEX }, null,
  ]) await assert.rejects(deleteFixtureArtifact(id, scope, { read: async () => different, remove }), /artifact_creator_scope/)
  assert.equal(deletes, 0)
  await deleteFixtureArtifact(id, scope, { read: async () => own, remove })
  assert.equal(deletes, 1)
  await assert.rejects(deleteFixtureArtifact(id, { ...scope, runIds: new Set() }, { read: async () => own, remove }), /artifact_creator_scope/)
  assert.equal(deletes, 1, 'an unvalidated creation run cannot authorize a whole-history delete')
})

test('only host terminal provider chunks produce provider evidence', () => {
  const host = { type: 'data-run-state', data: { state: 'failed', stopReason: 'provider_failure', error: 'Model provider failed (balance: insufficient_balance; HTTP 402)' } }
  assert.deepEqual(providerReceipt({ chunks: [{ chunk: host }] }), { kind: 'balance', code: 'insufficient_balance', status: 402 })
  assert.equal(providerReceipt({ chunks: [{ chunk: { type: 'text-delta', delta: host.data.error } }] }), null)
  assert.equal(providerReceipt({ chunks: [{ chunk: { ...host, data: { ...host.data, stopReason: 'error' } } }] }), null)
  assert.equal(providerReceipt({ chunks: [{ chunk: { ...host, data: { ...host.data, state: 'cancelled' } } }] }), null)
  assert.equal(providerReceipt({ chunks: [{ chunk: { ...host, data: { ...host.data, error: 'HTTP 402 Authorization: secret' } } }] }), null)
})

test('one blocked or failed provider does not prevent either independent remaining case', async () => {
  const called = []
  const results = await independently(CASES, async item => {
    called.push(item.id)
    if (item.id === CASES[0].id) throw new AcceptanceError('provider_refused', 'blocked', { providerKind: 'balance', providerStatus: 402 })
    if (item.id === CASES[1].id) throw new Error('private provider body and cookie')
    return { status: 'pass', model: item.model }
  })
  assert.deepEqual(called, CASES.map(item => item.id))
  assert.deepEqual(results.map(item => item.status), ['blocked', 'failed', 'pass'])
  assert.equal(results[0].providerStatus, 402)
  assert.equal(results[1].code, 'acceptance_failed')
})

test('error reporting drops raw messages, causes, account labels, cookies and non-allowlisted refusal codes', () => {
  const privateValue = 'person@example.invalid bearer-secret'
  const ordinary = Object.assign(new Error(privateValue), { code: privateValue, cause: { cookie: privateValue } })
  const controlled = new AcceptanceError('http_refused', 'blocked', { httpStatus: 403, serverCode: privateValue, providerKind: privateValue, email: privateValue, raw: privateValue })
  const output = JSON.stringify([publicFailure(ordinary), publicFailure(controlled), publicFailure(new AcceptanceError(privateValue))])
  assert.ok(!output.includes('person@') && !output.includes('bearer-secret'))
  assert.deepEqual(publicFailure(controlled), { status: 'blocked', code: 'http_refused', httpStatus: 403 })
})

test('RSC result decoding follows the action return reference and rejects unapproved actions', () => {
  const value = { thread: { rootRunId: RUN }, chunks: [] }
  assert.deepEqual(actionResult(`0:{"a":"$@1","f":[],"b":"build"}\n1:${JSON.stringify(value)}\n`, 'getIssueThread'), value)
  assert.throws(() => actionResult('0:{"a":"$@1"}\n1:{"error":"executionModelUnknown"}', 'changeModelOrder'),
    error => publicFailure(error).serverCode === 'executionModelUnknown')
  assert.throws(() => actionResult('1:{"id":"key"}', 'createApiKey'), /action_not_allowed/)
  assert.throws(() => actionResult('1:{"bots":[]}', 'listWorkspaceBots'), /action_not_allowed/)
})

function preflightFetch({ missingDeepseek = false, codexOnlyDefault = false,
  workspaceState = { bots: [{ status: 'idle', runningThreads: 0 }] }, workspaceStatus = 200, threads = [] } = {}) {
  const state = inventory(), calls = []
  if (missingDeepseek) state.keys.keys = []
  if (codexOnlyDefault) {
    state.order.entries = state.order.entries.filter(entry => entry.model === 'gpt-6-luna')
    state.order.customized = false
  }
  const respond = body => Response.json(body)
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url), path = parsed.pathname, method = init.method ?? 'GET'
    calls.push({ path, method, body: init.body })
    assert.equal(parsed.origin, ORIGIN)
    assert.equal(init.redirect, 'error')
    if (path === '/mikka/api/version') return respond({ build: SHA })
    if (path === '/mikka/api/auth/sign-in/email') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'session=private-cookie; Secure; HttpOnly' } })
    if (path === '/mikka/api/auth/get-session') return respond({ user: { id: OWNER, email: 'test+mikka-smoke-provider@example.invalid' } })
    if (path === '/mikka/api/auth/sign-out') return respond({ success: true })
    if (path === '/mikka/api/bots') {
      assert.equal(method, 'GET', 'preflight creates no Bot')
      return respond([{ id: BOT, name: 'Smoke Bot', ownerId: OWNER, workspaceId: WS }])
    }
    if (path === '/mikka/en' && method === 'GET') return new Response('<script src="/mikka/_next/static/chunks/actions.js"></script>')
    if (path === '/mikka/_next/static/chunks/actions.js') return new Response(actionNames.map(name => `createServerReference)("${refs[name]}",x,"${name}")`).join(';'))
    if (path === '/mikka/en') throw new Error('preflight must not invoke a server action')
    if (path === '/mikka/api/settings/api-keys') return respond(state.keys)
    if (path === '/mikka/api/settings/model-order') return respond(state.order)
    if (path === '/mikka/api/settings/workspace-bots') {
      assert.equal(method, 'GET')
      return Response.json(workspaceState, { status: workspaceStatus })
    }
    if (path === '/mikka/api/subscriptions') return respond(state.connections)
    if (path === '/mikka/api/mobile/threads') return respond({ threads })
    if (path === '/mikka/api/mobile/model') return respond({ groups: CASES.slice(1).map((item, index) => ({ kind: 'subscription', provider: item.provider,
      options: [{ id: index ? CODEX : CLAUDE, provider: item.provider, modelId: item.model }] })) })
    throw new Error(`Unexpected private request ${path}`)
  }
  return { fetchImpl, calls }
}
const env = () => ({ SMOKE_OWNER_EMAIL: 'test+mikka-smoke-provider@example.invalid', SMOKE_OWNER_PASSWORD: 'private-password', MIKKA_EXPECTED_DEPLOYMENT_SHA: SHA })

test('real HTTP preflight creates no task, Bot, key, binding or order and still checks both subscriptions when DeepSeek is missing', async () => {
  const { fetchImpl, calls } = preflightFetch({ missingDeepseek: true })
  const report = await runModelProviderAcceptance({ env: env(), fetchImpl })
  assert.equal(report.status, 'partial')
  assert.deepEqual(report.cases.map(item => item.status), ['blocked', 'ready', 'ready'])
  assert.equal(report.cases[0].code, 'source_missing')
  assert.equal(report.sessionClosed, true)
  const writes = calls.filter(call => call.method !== 'GET').map(call => call.path)
  assert.deepEqual(writes, ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  assert.equal(calls.filter(call => call.path === '/mikka/api/settings/workspace-bots').length, 2)
  const output = JSON.stringify(report)
  for (const value of ['private-password', 'private-cookie', 'example.invalid', OWNER, KEY, CLAUDE, CODEX]) assert.ok(!output.includes(value), value)
})

test('a busy workspace Bot or waiting own thread blocks every paid case before order or task writes', async () => {
  for (const fixture of [
    { workspaceState: { bots: [{ ownerId: 'another-workspace-member', status: 'running', runningThreads: 1 }] } },
    { workspaceState: { bots: [{ status: 'idle', runningThreads: 1 }] } },
    { threads: [{ status: 'paused' }] },
    { threads: [{ status: 'waiting' }] },
  ]) {
    const { fetchImpl, calls } = preflightFetch(fixture)
    const report = await runModelProviderAcceptance({ env: { ...env(), MIKKA_PROVIDER_ACCEPTANCE_MODE: 'active',
      MIKKA_WORKER_RELEASE_SHA: SHA, MIKKA_WORKER_RELEASE_RUN_ID: '12345' }, fetchImpl })
    assert.deepEqual(report.cases.map(item => [item.status, item.code]), CASES.map(() => ['blocked', 'workspace_busy']))
    assert.equal(report.sessionClosed, true)
    assert.deepEqual(calls.filter(call => call.method !== 'GET').map(call => call.path),
      ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  }
})

test('the workspace GET refuses HTTP failures and the existing action error body independently for all three cases', async () => {
  for (const [workspaceStatus, error] of [[401, 'authRequired'], [403, 'workspaceAccessDenied'], [200, 'workspaceAccessDenied']]) {
    const { fetchImpl, calls } = preflightFetch({ workspaceStatus, workspaceState: { error, secret: 'private-upstream-body' } })
    const report = await runModelProviderAcceptance({ env: env(), fetchImpl })
    assert.deepEqual(report.cases.map(item => [item.status, item.code, item.httpStatus, item.serverCode]),
      CASES.map(() => ['blocked', 'http_refused', workspaceStatus, error]))
    assert.equal(calls.filter(call => call.path === '/mikka/api/settings/workspace-bots').length, 3)
    assert.ok(!JSON.stringify(report).includes('private-upstream-body'))
    assert.deepEqual(calls.filter(call => call.method !== 'GET').map(call => call.path),
      ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  }
})

test('missing or malformed activity data cannot establish an idle workspace', async () => {
  for (const fixture of [
    { workspaceState: null }, { workspaceState: { bots: null } },
    { workspaceState: { bots: [null] } }, { workspaceState: { bots: [{ status: 'idle', runningThreads: '0' }] } },
    { workspaceState: { bots: [{ status: 'unknown', runningThreads: 0 }] } },
    { threads: null }, { threads: [{ status: 'unknown' }] },
  ]) {
    const { fetchImpl, calls } = preflightFetch(fixture)
    const report = await runModelProviderAcceptance({ env: env(), fetchImpl })
    assert.deepEqual(report.cases.map(item => [item.status, item.code]), CASES.map(() => ['blocked', 'response_invalid']))
    assert.deepEqual(calls.filter(call => call.method !== 'GET').map(call => call.path),
      ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  }
})

test('an un-restorable Claude check order blocks only that path and still preflights a safe default Codex order', async () => {
  const { fetchImpl, calls } = preflightFetch({ missingDeepseek: true, codexOnlyDefault: true })
  const report = await runModelProviderAcceptance({ env: env(), fetchImpl })
  assert.deepEqual(report.cases.map(item => item.status), ['blocked', 'blocked', 'ready'])
  assert.equal(report.cases[1].code, 'order_restore_unavailable')
  assert.equal(report.cases[2].preflight.orderAlreadyMatches, true)
  assert.equal(report.cases[2].preflight.checkModelsRestricted, true)
  assert.ok(!calls.some(call => call.method === 'PUT' || (call.method === 'POST' && ['/mikka/api/bots', '/mikka/api/mobile/chat'].includes(call.path))))
})

test('unconfirmed official worker release blocks active cases before creating paid fixtures', async () => {
  const { fetchImpl, calls } = preflightFetch()
  const report = await runModelProviderAcceptance({ env: { ...env(), MIKKA_PROVIDER_ACCEPTANCE_MODE: 'active' }, fetchImpl })
  assert.deepEqual(report.cases.map(item => item.code), ['worker_release', 'worker_release', 'worker_release'])
  assert.ok(!calls.some(call => call.method === 'POST' && ['/mikka/api/bots', '/mikka/api/mobile/chat'].includes(call.path)))
  assert.ok(!calls.some(call => call.method === 'PUT' || call.method === 'DELETE'))
})

test('foreign origins and non-smoke accounts fail before any network request', async () => {
  let requests = 0
  const fetchImpl = () => { requests++; throw new Error('must not call') }
  await assert.rejects(runModelProviderAcceptance({ env: { ...env(), MIKKA_ACCEPTANCE_BASE_URL: 'https://elsewhere.invalid/mikka' }, fetchImpl }), /origin_rejected/)
  await assert.rejects(runModelProviderAcceptance({ env: { ...env(), SMOKE_OWNER_EMAIL: 'ordinary@example.invalid' }, fetchImpl }), /account_required/)
  assert.equal(requests, 0)
})
