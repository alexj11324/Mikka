import assert from 'node:assert/strict'
import test from 'node:test'
import { READ_ACTIONS } from './read-cache.mjs'
import { SCENARIOS, attestProductionReadCache, mergeReadChat, mergeReadList, productionGuard, productionOutcome,
  productionRequestAllowed, publicFailure, runProductionReadCache } from './read-cache-production.mjs'

const APP = 'a'.repeat(40), OTHER = 'b'.repeat(40), NOW = Date.parse('2026-11-05T12:00:00Z')
const ORIGIN = 'https://app.aspectlylabs.com', REPOSITORY = 'alexj11324/Mikka'
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = 'synthetic-smoke-owner', WORKSPACE = id(1), BOT = id(2), TASK = id(3)
const EMAIL = 'fixture+mikka-smoke-owner@example.invalid', PASSWORD = 'SYNTHETIC-PASSWORD-NOT-EVIDENCE'
const COOKIE = 'SYNTHETIC-COOKIE-NOT-EVIDENCE', PRIVATE = 'PRIVATE-CONTENT-NOT-EVIDENCE'
const V1 = '1'.repeat(32), V2 = '2'.repeat(32), PREFIX = '3'.repeat(32)
const refs = Object.fromEntries(READ_ACTIONS.map((name, index) => [name, String(index + 1).repeat(40)]))
const env = () => ({ GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: APP, GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GH_TOKEN: 'SYNTHETIC-GH-TOKEN', SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: PASSWORD })
const event = () => ({ repository: { full_name: REPOSITORY }, inputs: { application_sha: APP } })
const repositoryApi = `https://api.github.com/repos/${REPOSITORY}`
const webRelease = () => ({ id: 10, name: 'Web deploy', path: '.github/workflows/web-deploy.yml',
  url: `${repositoryApi}/actions/runs/10`, event: 'push', head_branch: 'main', head_sha: APP,
  repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, status: 'completed', conclusion: 'success' })
const automaticEnv = () => ({ ...env(), GITHUB_EVENT_NAME: 'workflow_run' })
const automaticEvent = () => ({ action: 'completed', repository: { full_name: REPOSITORY }, workflow_run: webRelease() })
const issue = () => ({ number: 1372, url: `${repositoryApi}/issues/1372`, repository_url: repositoryApi, state: 'open' })
const noCredentials = values => new Proxy(values, { get(target, key) {
  if (String(key).startsWith('SMOKE_')) assert.fail('smoke credentials accessed before authorization')
  return target[key]
} })
const attestation = () => ({ purpose: 'production-readiness', status: 'partial', repository: REPOSITORY,
  applicationSha: APP, driverRevision: APP, mode: 'readonly', metadataReadAuthorized: true, executionReady: false,
  webDeployRunId: 10, runtime: { status: 'unproven', code: 'release_missing', sourceCommit: null, workerSha: null },
  checkedAt: new Date(NOW).toISOString() })
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
const flight = value => new Response(`0:{"a":"$@1"}\n1:${JSON.stringify(value)}\n`, { headers: { 'content-type': 'text/x-component' } })
const row = value => ({ id: value, title: PRIVATE })
const position = (value, revision = V1) => ({ id: value, version: revision })
const live = () => ({ ownerId: OWNER, workspaceId: WORKSPACE, selectedWorkspaceId: WORKSPACE })

function fixture(options = {}) {
  const calls = [], actions = [], counts = new Map()
  let versions = 0
  const list = (name, read, args) => {
    const ids = name === 'syncIssueList' ? [TASK, id(4)] : name === 'syncThreadList' ? [id(5), id(6)] : [id(7), id(8)]
    const changed = options.changed && read >= 2, current = changed ? V2 : V1
    const offset = name === 'pollIssueVersionSummaries' ? 1 : 0
    if (read === 1 || args[offset] == null && args[offset + 1] == null) return {
      version: current,
      items: ids.map(value => ({ ...row(value), ...(options.rejectedNonChat ? { credential: PRIVATE } : {}) })),
      positions: ids.map(value => position(value, current)), live: live(),
    }
    if (changed && read === 2) return { version: current, delta: true, items: [row(ids[0]), row(id(9))],
      positions: [position(ids[0], V2), position(id(9), V2)], live: live() }
    if (changed && read === 4) return { version: current, delta: true, items: [], positions: [position(ids[0], V2)], live: live() }
    if (args[offset] == null && Array.isArray(args[offset + 1])) {
      const positions = (changed ? [ids[0]] : ids).map(value => position(value, current))
      const previous = new Map(args[offset + 1].map(value => [value.id, value.version]))
      return { version: current, delta: true, positions,
        items: positions.filter(value => previous.get(value.id) !== value.version).map(value => row(value.id)), live: live() }
    }
    return { version: current, unchanged: true, live: live() }
  }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), headers = new Headers(init.headers), method = init.method ?? 'GET'
    calls.push({ path: url.pathname + url.search, method, cookie: headers.get('cookie'), body: init.body })
    assert.equal(url.origin, ORIGIN)
    assert.equal(init.redirect, 'error')
    assert.equal(headers.get('authorization'), null, 'a GitHub token never reaches the application')
    if (url.pathname === '/mikka/api/version') return json({ build: ++versions === options.buildChangeAt ? OTHER : APP })
    if (url.pathname === '/mikka/api/auth/sign-in/email') {
      assert.equal(headers.get('cookie'), null, 'the driver cannot inherit another session')
      assert.deepEqual(JSON.parse(init.body), { email: EMAIL, password: PASSWORD })
      return json({}, options.loginStatus ?? 200, { 'set-cookie': `better-auth.session_token=${COOKIE}; HttpOnly; Secure` })
    }
    assert.equal(headers.get('cookie'), `better-auth.session_token=${COOKIE}`)
    if (url.pathname === '/mikka/api/auth/sign-out') return json({}, options.logoutStatus ?? 200)
    if (url.pathname === '/mikka/api/auth/get-session') return json({ user: { id: OWNER, email: options.foreignEmail ? 'other@example.invalid' : EMAIL } })
    if (url.pathname === '/mikka/api/bots') {
      if (options.redirect) return new Response('', { status: 302, headers: { location: 'https://foreign.invalid/private' } })
      if (options.requestError) throw new Error(PASSWORD + COOKIE + PRIVATE)
      return json(options.noBot ? [] : [{ id: BOT, ownerId: options.foreignBot ? 'other-owner' : OWNER, workspaceId: WORKSPACE, name: PRIVATE }])
    }
    if (url.pathname === '/mikka/api/settings/issue-prefix') return json({ suggested: PRIVATE, teamKeys: [PRIVATE] })
    if (url.pathname === '/mikka/en' && method === 'POST') {
      const name = READ_ACTIONS.find(value => refs[value] === headers.get('next-action'))
      assert.ok(name, 'only a discovered read reference can be invoked')
      const args = JSON.parse(init.body), read = (counts.get(name) ?? 0) + 1
      counts.set(name, read); actions.push({ name, args, read })
      assert.match(headers.get('traceparent'), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
      if (options.accessLost && name === 'pollIssue') return flight({ error: 'issueNotFound' })
      if (name === 'syncIssueList' || name === 'syncThreadList') return flight({ snapshot: options.noTask && name === 'syncIssueList'
        ? { version: V1, items: [], positions: [], live: live() } : list(name, read, args) })
      if (name === 'pollIssueVersionSummaries') return flight({ viewerId: OWNER, snapshot: list(name, read, args) })
      if (name === 'pollIssue') {
        const current = options.changed && read >= 2 ? V2 : V1
        return flight({ viewerId: options.foreignViewer ? 'foreign' : OWNER, version: current,
          ...(args[1] === current ? { unchanged: true } : { issue: { id: TASK, title: PRIVATE, content: {
            type: 'doc', content: PRIVATE, ...(options.rejectedNonChat ? { attrs: { integrationPayload: PRIVATE } } : {}),
          } } }) })
      }
      const current = options.changed && read >= 2 ? V2 : V1
      const cursor = (options.toolMetadata ? 4 : 2) + (options.changed && read >= 2 ? 1 : 0), previous = args[2]
      if (args[1] === current) return flight({ chat: { botId: BOT, version: current, cursor, unchanged: true, live: live() } })
      const after = previous?.after ?? -1
      const failedTool = ['errorCode', 'errorDetail'].includes(options.toolMetadata)
      return flight({ chat: { botId: BOT, version: current, cursor, live: live(), sources: {}, artifacts: {},
        items: Array.from({ length: cursor }, (_, index) => ({ position: index + 1, from: index === 2 ? 'person' : 'coordinator', text: PRIVATE,
          ...(options.toolMetadata && index === 0 ? { activity: { tools: [{ call: 'tool-call', name: 'github_call', state: failedTool ? 'error' : 'done', at: 1, [options.toolMetadata]: PRIVATE }] } } : {}),
        })).filter(item => item.position > after && !(options.toolMetadata && item.position === 2)),
        continuation: { after: cursor - 1, cursor, prefix: PREFIX },
        ...(previous?.restoreToolMetadata ? { toolMetadata: { baseCursor: previous.cursor, prefix: previous.prefix, rows: options.incompleteMetadata ? [] : [
          { position: 1, parts: [{ ordinal: 1, type: 'tool-call', toolCallId: 'tool-call', toolName: 'github_call',
            ...(options.toolMetadata === 'target' ? { target: PRIVATE } : {}), ...(options.toolMetadata === 'displayName' ? { operationName: PRIVATE } : {}) }] },
          { position: 2, parts: [{ ordinal: 1, type: 'tool-result', toolCallId: 'tool-call', status: failedTool ? 'error' : 'done',
            ...(failedTool ? { [options.toolMetadata]: PRIVATE } : {}) }] },
        ] } } : {}),
        ...(previous ? { after, baseCursor: previous.cursor, metadataRefresh: true } : {}) } })
    }
    if (url.pathname === '/mikka/en' || url.pathname === '/mikka/en/settings') return new Response('<script src="/mikka/_next/static/chunks/read.js"></script>')
    if (url.pathname === '/mikka/_next/static/chunks/read.js') return new Response(READ_ACTIONS.map(name =>
      `createServerReference("${refs[name]}",callServer,void 0,findSourceMapURL,"${name}")`).join(';'))
    assert.fail('unexpected request')
  }
  return { calls, actions, run: args => runProductionReadCache({ env: env(), event: event(), attestation: attestation(), fetchImpl, now: () => NOW, ...args }) }
}

test('manual triggers require main and the same application and driver SHA', () => {
  assert.deepEqual(productionGuard(env(), event()), { applicationSha: APP, driverRevision: APP, mode: 'readonly' })
  for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/acceptance/proactive-1157-1163' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'foreign/repo' }, { GITHUB_SHA: OTHER }])
    assert.throws(() => productionGuard({ ...env(), ...change }, event()), /trigger_rejected/)
  assert.throws(() => productionGuard(env(), { ...event(), repository: { full_name: 'foreign/repo' } }), /trigger_rejected/)
  assert.throws(() => productionGuard(env(), { ...event(), inputs: { application_sha: APP, mode: 'active' } }), /trigger_rejected/)
})

test('workflow_run accepts only the real successful same-repository main push Web deploy event', () => {
  assert.deepEqual(productionGuard(automaticEnv(), automaticEvent()), {
    applicationSha: APP, driverRevision: APP, mode: 'readonly', trigger: 'workflow_run', webDeployRunId: 10,
  })
  for (const patch of [{ id: -1 }, { id: 11 }, { name: 'Other deploy' }, { path: '.github/workflows/untrusted.yml' },
    { url: 'https://api.github.com/repos/foreign/repo/actions/runs/10' }, { event: 'pull_request' }, { event: 'workflow_dispatch' },
    { head_branch: 'feature' }, { head_sha: OTHER }, { repository: { full_name: 'foreign/repo' } },
    { head_repository: { full_name: 'foreign/repo' } }, { status: 'in_progress' }, { conclusion: 'failure' }])
    assert.throws(() => productionGuard(automaticEnv(), { ...automaticEvent(), workflow_run: { ...webRelease(), ...patch } }), /trigger_rejected/)
  for (const patch of [{ GITHUB_REF: 'refs/heads/other' }, { GITHUB_REPOSITORY: 'foreign/repo' }, { GITHUB_SHA: OTHER }])
    assert.throws(() => productionGuard({ ...automaticEnv(), ...patch }, automaticEvent()), /trigger_rejected/)
  assert.throws(() => productionGuard(automaticEnv(), { ...automaticEvent(), action: 'requested' }), /trigger_rejected/)
  assert.throws(() => productionGuard(automaticEnv(), { ...automaticEvent(), repository: { full_name: 'foreign/repo' } }), /trigger_rejected/)
  assert.throws(() => productionGuard(automaticEnv(), {}), /trigger_rejected/)
})

function automaticProof(options = {}) {
  const calls = []
  let versions = 0
  const fetchImpl = async (input, init) => {
    const url = new URL(input); calls.push(url.toString())
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
    if (url.origin === 'https://api.github.com') {
      assert.equal(init.headers.authorization, 'Bearer SYNTHETIC-GH-TOKEN')
      if (url.pathname.endsWith('/issues/1372')) return json({ ...issue(), ...options.issue })
      assert.equal(url.toString(), `${repositoryApi}/actions/runs/10`, 'recheck the exact triggering run')
      return json({ ...webRelease(), ...options.run })
    }
    assert.equal(url.toString(), `${ORIGIN}/mikka/api/version`)
    assert.equal(init.headers.authorization, undefined)
    return json({ build: ++versions === options.buildChangeAt ? OTHER : APP })
  }
  return { calls, attest: () => attestProductionReadCache({ env: noCredentials(automaticEnv()), event: automaticEvent(), fetchImpl, now: () => NOW }) }
}

test('automatic proof checks the open issue, exact GitHub run and both public build pins before credentials', async () => {
  const f = automaticProof(), proof = await f.attest()
  assert.equal(proof.status, 'ready'); assert.equal(proof.purpose, 'production-read-cache')
  assert.equal(proof.metadataReadAuthorized, true); assert.equal(proof.readable, true)
  assert.equal(proof.webDeployRunId, 10); assert.equal(proof.issueNumber, 1372); assert.equal(proof.issueState, 'open')
  assert.deepEqual(f.calls, [`${repositoryApi}/issues/1372`, `${ORIGIN}/mikka/api/version`,
    `${repositoryApi}/actions/runs/10`, `${ORIGIN}/mikka/api/version`])
  assert.deepEqual(productionOutcome(proof, true), { readable: true, exitCode: 0 })
  const accepted = await fixture().run({ env: automaticEnv(), event: automaticEvent(), attestation: proof })
  assert.equal(accepted.status, 'pass'); assert.equal(accepted.sessionClosed, true)
  assert.equal(accepted.trigger, 'workflow_run')
})

test('an event alone cannot authorize secrets when the run API, issue identity or production SHA disagrees', async () => {
  for (const patch of [{ id: 11 }, { path: '.github/workflows/untrusted.yml' }, { event: 'pull_request' }, { event: 'workflow_dispatch' },
    { repository: { full_name: 'foreign/repo' } }, { head_repository: { full_name: 'foreign/repo' } },
    { head_branch: 'feature' }, { head_sha: OTHER }, { status: 'in_progress' }, { conclusion: 'failure' }])
    await assert.rejects(automaticProof({ run: patch }).attest(), /web_deploy/)
  for (const patch of [{ number: 999 }, { url: `${repositoryApi}/issues/999` }, { repository_url: 'https://api.github.com/repos/foreign/repo' },
    { pull_request: { url: 'https://api.github.com/pulls/1372' } }, { state: 'unknown' }])
    await assert.rejects(automaticProof({ issue: patch }).attest(), /issue_proof/)
  for (const buildChangeAt of [1, 2]) await assert.rejects(automaticProof({ buildChangeAt }).attest(), /build_mismatch/)
  const proof = await automaticProof().attest()
  for (const attestation of [{ ...proof, webDeployRunId: 11 }, { ...proof, issueNumber: 999 }, { ...proof, issueState: 'closed' },
    { ...proof, trigger: 'workflow_dispatch' }, { ...proof, purpose: 'production-readiness' }])
    await assert.rejects(runProductionReadCache({ env: noCredentials(automaticEnv()), event: automaticEvent(), attestation,
      now: () => NOW, fetchImpl: () => assert.fail('application read before proof') }), /attestation_required/)
})

test('closed issue skips automatically with readable=false and exit zero without credentials or application requests', async () => {
  const f = automaticProof({ issue: { state: 'closed' } }), proof = await f.attest()
  assert.equal(proof.status, 'skipped'); assert.equal(proof.code, 'issue_closed')
  assert.deepEqual(f.calls, [`${repositoryApi}/issues/1372`])
  assert.deepEqual(productionOutcome(proof, true), { readable: false, exitCode: 0 })
  const report = await runProductionReadCache({ env: noCredentials(automaticEnv()), event: automaticEvent(), attestation: proof,
    now: () => NOW, fetchImpl: () => assert.fail('closed issue must not call production') })
  assert.deepEqual(productionOutcome(report), { readable: false, exitCode: 0 })
  assert.deepEqual(productionOutcome({ status: 'blocked' }, true), { readable: false, exitCode: 1 })
})

test('the existing Web deploy proof runs before smoke credentials and binds both public version observations', async () => {
  const guarded = new Proxy(env(), { get(target, key) { if (String(key).startsWith('SMOKE_')) assert.fail('credentials read before proof'); return target[key] } })
  const calls = []
  const actual = await attestProductionReadCache({ env: guarded, event: event(), now: () => NOW, fetchImpl: async (input, init) => {
    const url = new URL(input); calls.push(url)
    assert.equal(init.redirect, 'error')
    if (url.origin === 'https://api.github.com') {
      assert.equal(init.headers.authorization, 'Bearer SYNTHETIC-GH-TOKEN')
      return json({ workflow_runs: [{ id: 10, name: 'Web deploy', path: '.github/workflows/web-deploy.yml',
        event: 'push', head_branch: 'main', head_sha: APP, head_repository: { full_name: REPOSITORY }, status: 'completed', conclusion: 'success' }] })
    }
    assert.equal(init.headers.authorization, undefined)
    return json({ build: APP })
  } })
  assert.deepEqual(actual, attestation())
  assert.equal(calls.filter(url => url.pathname === '/mikka/api/version').length, 2)
})

test('wrong or stale proof fails before credentials or application requests', async () => {
  const guarded = new Proxy(env(), { get(target, key) { if (String(key).startsWith('SMOKE_')) assert.fail('credentials read'); return target[key] } })
  for (const patch of [{ purpose: 'other' }, { applicationSha: OTHER }, { driverRevision: OTHER }, { repository: 'foreign/repo' },
    { mode: 'active' }, { webDeployRunId: 0 }, { executionReady: true }, { metadataReadAuthorized: false },
    { checkedAt: new Date(NOW - 300001).toISOString() }, { checkedAt: new Date(NOW + 1).toISOString() }])
    await assert.rejects(runProductionReadCache({ env: guarded, event: event(), attestation: { ...attestation(), ...patch },
      now: () => NOW, fetchImpl: () => assert.fail('network before proof') }), /attestation_required/)
  await assert.rejects(fixture().run({ env: { ...env(), SMOKE_OWNER_EMAIL: 'ordinary@example.invalid' } }), /account_required/)
})

test('business allowlist rejects auth writes, data writers, arbitrary actions, redirects and credential overrides', () => {
  const init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/x-component', 'next-action': refs.pollIssue }, body: '[]' }
  assert.equal(productionRequestAllowed('/mikka/en', init, refs), true)
  assert.equal(productionRequestAllowed('/mikka/api/bots'), true)
  for (const path of ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out', '/mikka/api/bots', '/mikka/api/coordinator/messages', '/mikka/api/settings/issue-prefix'])
    assert.equal(productionRequestAllowed(path, init, refs), false)
  assert.equal(productionRequestAllowed('/mikka/en', { ...init, headers: { ...init.headers, 'next-action': 'f'.repeat(40) } }, refs), false)
  assert.equal(productionRequestAllowed('/mikka/en', init), false)
  for (const path of ['https://foreign.invalid/mikka/api/version', 'https://user@app.aspectlylabs.com/mikka/api/version',
    '/mikka/api/bots?workspace=' + WORKSPACE, '/mikka/_next/static/chunks/%2e%2e/private.js', '/mikka/api/settings/secrets'])
    assert.equal(productionRequestAllowed(path), false)
  for (const header of ['authorization', 'cookie', 'host']) assert.equal(productionRequestAllowed('/mikka/api/bots', { headers: { [header]: PRIVATE } }), false)
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(productionRequestAllowed('/mikka/api/bots', { method }), false)
})

test('stable production cursors cover four HTTP scenarios with only a normal owned session and safe evidence', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'pass')
  assert.equal(report.normalSessionObserved, true)
  assert.equal(report.sessionClosed, true)
  assert.equal(report.browserCacheVerified, false)
  assert.equal(report.reads.length, 27)
  assert.equal(report.businessMutationRequests, 0)
  assert.equal(report.modelCalls, 0)
  assert.equal(report.fixturesCreated, 0)
  for (const scenario of SCENARIOS) assert.equal(report.reads.filter(read => read.scenario === scenario).length, 6)
  for (const read of report.reads) {
    assert.ok(read.httpBytes > 0 && read.resultBytes > 0)
    assert.equal(read.httpStatus, 200)
    assert.match(read.traceId, /^[0-9a-f]{32}$/)
  }
  for (const name of ['syncIssueList', 'syncThreadList']) {
    const reads = f.actions.filter(action => action.name === name)
    assert.deepEqual(reads[0].args, [])
    for (const read of reads.slice(1, 4)) { assert.equal(read.args[0], V1); assert.equal(read.args[1].length, 2) }
  }
  const chats = f.actions.filter(action => action.name === 'syncCoordinatorChat')
  assert.equal(chats[1].args[1], V1)
  for (const read of chats.slice(2, 4)) { assert.equal(read.args[1], null); assert.equal(read.args[2].cursor, 2) }
  assert.equal(f.calls.filter(call => call.path === '/mikka/api/auth/sign-out').length, 1)
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 25)
  const evidence = JSON.stringify(report)
  for (const secret of [EMAIL, PASSWORD, COOKIE, PRIVATE, OWNER, WORKSPACE, BOT, TASK, refs.pollIssue]) assert.equal(evidence.includes(secret), false)
  assert.deepEqual(publicFailure(new Error(PASSWORD + COOKIE)), { status: 'fail', code: 'acceptance_failed' })
})

test('one-item repairs drop only client-held data and reuse genuine row and chat prefix proofs', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'pass')
  assert.equal(report.cacheMissProbe, 'discard-one-held-item-with-server-issued-proofs')
  const repairs = report.reads.filter(read => read.scenario === 'one-item-cache-miss')
  assert.deepEqual(repairs.map(read => [read.action, read.responseMode, read.receivedItems]), [
    ['syncIssueList', 'delta', 1], ['syncThreadList', 'delta', 1], ['syncCoordinatorChat', 'delta', 1],
  ])
  for (const name of ['syncIssueList', 'syncThreadList']) {
    const reads = f.actions.filter(action => action.name === name)
    assert.deepEqual(reads[4].args, [null, reads[3].args[1].slice(0, 1)])
  }
  const chats = f.actions.filter(action => action.name === 'syncCoordinatorChat')
  assert.deepEqual(chats[4].args, [BOT, null, { after: 1, cursor: 1, prefix: PREFIX, sourceIds: [], artifactIds: [] }])
  assert.equal(report.businessMutationRequests, 0)
  assert.equal(report.fixturesCreated, 0)
})

test('live deltas update restored proofs, remove absent rows and do not require every warm response to be unchanged', async () => {
  const f = fixture({ changed: true }), report = await f.run()
  assert.equal(report.status, 'pass')
  assert.ok(report.reads.some(read => read.scenario === 'warm' && read.responseMode === 'delta'))
  for (const name of ['syncIssueList', 'syncThreadList']) {
    const replay = f.actions.find(action => action.name === name && action.read === 3)
    assert.equal(replay.args[0], V2)
    assert.deepEqual(replay.args[1].map(item => item.version), [V2, V2])
  }
  const replay = f.actions.find(action => action.name === 'syncCoordinatorChat' && action.read === 3)
  assert.equal(replay.args[1], null)
  assert.equal(replay.args[2].cursor, 3)
  const previous = { version: V1, items: [row(TASK), row(id(4))], positions: [position(TASK), position(id(4))] }
  const next = { version: V2, delta: true, positions: [position(TASK, V2)], items: [{ id: TASK, title: 'changed' }] }
  assert.deepEqual(mergeReadList(previous, next, 100).items, next.items)
  assert.throws(() => mergeReadList(previous, { ...next, items: [] }, 100), /list_merge_invalid/)
  assert.throws(() => mergeReadChat({ cursor: 2, version: V1, items: [] }, { cursor: 3, version: V2, after: 1, baseCursor: 1, items: [] }), /chat_merge_invalid/)
})

test('plain chat persistence retains its continuation and measures an incremental restored read', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'pass')
  assert.equal(report.browserCacheVerified, false)
  const replay = f.actions.find(action => action.name === 'syncCoordinatorChat' && action.read === 3)
  assert.equal(replay.args[1], null)
  assert.deepEqual(replay.args[2], { after: 1, cursor: 2, prefix: PREFIX, sourceIds: [], artifactIds: [] })
  const measure = report.reads.find(read => read.action === 'syncCoordinatorChat' && read.scenario === 'reload-restored')
  assert.equal(measure.responseMode, 'delta')
  assert.equal(measure.receivedItems, 1)
})

test('projected tool metadata is measured as a prefix overlay without retransmitting cached message bodies', async () => {
  for (const toolMetadata of ['target', 'displayName', 'errorCode', 'errorDetail']) {
    const f = fixture({ toolMetadata }), report = await f.run()
    assert.equal(report.status, 'pass', toolMetadata)
    assert.equal(report.browserCacheVerified, false)
    const chats = f.actions.filter(action => action.name === 'syncCoordinatorChat')
    assert.equal(chats[1].args[1], V1, 'the preceding warm read still has its complete in-memory snapshot')
    assert.equal(chats[2].args[1], null, 'the restored view is reauthorized before known-version reads')
    assert.deepEqual(chats[2].args[2], { after: 3, cursor: 4, prefix: PREFIX, restoreToolMetadata: true, sourceIds: [], artifactIds: [] })
    assert.equal(chats[3].args[1], null)
    assert.equal(chats[3].args[2].cursor, 4, 'the repair response supplies the next incremental continuation')
    assert.equal(chats[3].args[2].restoreToolMetadata, undefined, 'the successful repair consumes its hint')
    const reads = report.reads.filter(read => read.action === 'syncCoordinatorChat')
    assert.equal(reads[2].responseMode, 'delta')
    assert.equal(reads[2].receivedItems, 1, 'only the overlapping tail includes message bodies')
    assert.equal(reads[2].toolMetadataRows, 2, 'both prefix metadata rows are included in measured HTTP bytes')
    assert.equal(reads[3].responseMode, 'delta')
    assert.equal(reads[3].receivedItems, 1)
    assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  }
})

test('an incomplete metadata repair counts its one full reset and resumes normal cursor reads', async () => {
  const f = fixture({ toolMetadata: 'target', incompleteMetadata: true }), report = await f.run()
  assert.equal(report.status, 'pass')
  assert.equal(report.browserCacheVerified, false)
  const reloads = report.reads.filter(read => read.action === 'syncCoordinatorChat' && read.scenario === 'reload-restored')
  assert.deepEqual(reloads.map(read => read.responseMode), ['delta', 'snapshot'])
  const chats = f.actions.filter(action => action.name === 'syncCoordinatorChat')
  assert.deepEqual(chats[3].args, [BOT])
  assert.equal(chats[4].args[2].restoreToolMetadata, undefined)
})

test('rejected task, thread and activity records reload without their former version or row proofs', async () => {
  const f = fixture({ rejectedNonChat: true }), report = await f.run()
  assert.equal(report.status, 'pass')
  assert.equal(report.browserCacheVerified, false)
  for (const name of ['syncIssueList', 'syncThreadList', 'pollIssue', 'pollIssueVersionSummaries']) {
    const reads = f.actions.filter(action => action.name === name)
    const offset = name === 'pollIssue' || name === 'pollIssueVersionSummaries' ? 1 : 0
    assert.equal(reads[1].args[offset], V1, 'warm memory remains usable before restart')
    assert.ok(reads[2].args[offset] == null, `${name} cannot send a rejected version`)
    assert.ok(reads[2].args[offset + 1] == null, `${name} cannot send rejected row proofs`)
    assert.equal(reads[3].args[offset], V1, `${name} uses the freshly authorized response on the next read`)
    assert.equal(report.reads.find(read => read.action === name && read.scenario === 'reload-restored').responseMode, 'snapshot')
  }
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('missing existing resources are blocked and never cause fixture creation', async () => {
  for (const [options, code] of [[{ noBot: true }, 'existing_bot_missing'], [{ noTask: true }, 'existing_task_missing']]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'blocked'); assert.equal(report.code, code)
    assert.equal(report.sessionClosed, true)
    assert.equal(f.calls.filter(call => call.path === '/mikka/api/auth/sign-out').length, 1)
    assert.equal(report.fixturesCreated, 0)
  }
})

test('identity/access changes and response redirects stop the read sequence and still close only this login cookie', async () => {
  for (const [options, code] of [[{ foreignEmail: true }, 'session_identity'], [{ foreignBot: true }, 'scope_changed'],
    [{ foreignViewer: true }, 'scope_changed'], [{ accessLost: true }, 'read_access_changed'], [{ redirect: true }, 'redirect_refused'],
    [{ requestError: true }, 'request_failed'], [{ buildChangeAt: 2 }, 'build_mismatch']]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.code, code)
    assert.notEqual(report.status, 'pass')
    assert.equal(report.sessionClosed, true)
    const logouts = f.calls.filter(call => call.path === '/mikka/api/auth/sign-out')
    assert.equal(logouts.length, 1)
    assert.equal(logouts[0].cookie, `better-auth.session_token=${COOKIE}`)
    const evidence = JSON.stringify(report)
    for (const secret of [EMAIL, PASSWORD, COOKIE, PRIVATE, OWNER, BOT, TASK]) assert.equal(evidence.includes(secret), false)
  }
})

test('a failed sign-out blocks success, and a pre-login build mismatch never sends a credential', async () => {
  const failed = await fixture({ logoutStatus: 500 }).run()
  assert.equal(failed.status, 'blocked'); assert.equal(failed.code, 'session_close_failed'); assert.equal(failed.sessionClosed, false)
  const f = fixture({ buildChangeAt: 1 }), report = await f.run()
  assert.equal(report.code, 'build_mismatch')
  assert.equal(f.calls.some(call => call.path.includes('/api/auth/')), false)
})
