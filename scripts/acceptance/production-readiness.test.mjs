import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  ACCEPTANCE_BRANCH, READINESS_ACTIONS, attestReadiness, discoverReadinessActions,
  publicFailure, requestAllowed, runReadiness, runtimePublicationProof, triggerGuard,
} from './production-readiness.mjs'

const APP = 'a'.repeat(40), DRIVER = 'b'.repeat(40), NOW = Date.parse('2026-11-04T22:00:00Z')
const id = n => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`
const OWNER = 'fixture-smoke-owner', WORKSPACE = id(1)
const EMAIL = 'fixture+mikka-smoke-owner@example.invalid', PASSWORD = 'SYNTHETIC-PASSWORD-DO-NOT-REPORT'
const COOKIE = 'SYNTHETIC-COOKIE-DO-NOT-REPORT'
const env = () => ({ GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_SHA: DRIVER,
  GITHUB_REF: ACCEPTANCE_BRANCH, GITHUB_EVENT_NAME: 'push', GH_TOKEN: 'SYNTHETIC-GITHUB-TOKEN',
  SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: PASSWORD })
const event = () => ({ repository: { full_name: 'alexj11324/Mikka' }, ref: ACCEPTANCE_BRANCH, after: DRIVER, deleted: false })
const plan = () => ({ purpose: 'production-readiness', mode: 'readonly', applicationSha: APP })
const attestation = () => ({ purpose: 'production-readiness', status: 'ready', repository: 'alexj11324/Mikka',
  applicationSha: APP, driverRevision: DRIVER, mode: 'readonly', webDeployRunId: 10,
  metadataReadAuthorized: true, executionReady: false,
  runtime: { status: 'published', runId: 11, sourceCommit: APP, workerSha: null,
    sourceEvidence: 'verified_publish_step', validateJobId: 110, publishJobId: 111 }, checkedAt: new Date(NOW).toISOString() })
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
})
const reference = name => `createServerReference("${'1'.repeat(40)}", callServer, void 0, findSourceMapURL, "${name}")`
const release = kind => ({ id: kind === 'web' ? 10 : 11, name: kind === 'web' ? 'Web deploy' : 'E2B official instance runtime',
  path: '.github/workflows/' + (kind === 'web' ? 'web-deploy.yml' : 'e2b-official-runtime.yml'), event: 'push',
  head_branch: 'main', head_sha: APP, head_repository: { full_name: 'alexj11324/Mikka' }, status: 'completed', conclusion: 'success' })
const publishedJobs = () => [
  { id: 110, run_id: 11, name: 'validate', status: 'completed', conclusion: 'success',
    steps: [{ name: 'Validate new official instances without template mutation', status: 'completed', conclusion: 'success' }] },
  { id: 111, run_id: 11, name: 'publish', status: 'completed', conclusion: 'success',
    steps: [{ name: 'Publish the verified official runtime pair', status: 'completed', conclusion: 'success' }] },
]

function fixture(options = {}) {
  const entries = [
    { id: id(11), harness: 'claude_code', model: 'deepseek-flash', source: { kind: 'api_key', keyId: id(2) }, credentialOwnerId: OWNER },
    { id: id(12), harness: 'claude_code', model: 'claude-haiku-5-5', source: { kind: 'subscription', connectionId: id(3) }, credentialOwnerId: OWNER },
    { id: id(13), harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: id(4) }, credentialOwnerId: OWNER },
  ]
  const order = { entries, candidates: structuredClone(entries), customized: true, location: 'cloud', cloudReady: true,
    preferredHarness: 'claude_code', cloudModels: Object.fromEntries(entries.map(entry => [entry.id, 'ready'])) }
  options.order?.(order)
  const calls = []
  let orderReads = 0, versionReads = 0
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET'
    calls.push({ path: url.pathname + url.search, method, headers: init.headers, body: init.body })
    assert.equal(url.origin, 'https://app.aspectlylabs.com')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, undefined)
    if (url.pathname === '/mikka/api/version') return response({ build: ++versionReads >= (options.buildChangeAt ?? Infinity) ? 'c'.repeat(40) : APP })
    if (url.pathname === '/mikka/api/auth/sign-in/email') {
      assert.deepEqual(JSON.parse(init.body), { email: EMAIL, password: PASSWORD })
      return response({}, options.loginStatus ?? 200, { 'set-cookie': 'better-auth.session_token=' + COOKIE + '; HttpOnly; Secure' })
    }
    assert.equal(init.headers.cookie, 'better-auth.session_token=' + COOKIE)
    if (url.pathname === '/mikka/api/auth/sign-out') return response({}, options.logoutStatus ?? 200)
    if (url.pathname === '/mikka/api/auth/get-session') return response({ user: { id: OWNER, email: options.foreignEmail ? 'other@example.invalid' : EMAIL } })
    if (url.pathname === '/mikka/api/bots') return response([{ id: id(5), ownerId: options.foreignBot ? 'other-owner' : OWNER, workspaceId: WORKSPACE }])
    if (url.pathname === '/mikka/api/settings/model-order') {
      assert.equal(url.search, '?workspace=' + WORKSPACE)
      const value = structuredClone(order)
      if (++orderReads > 1 && options.orderChanged) value.entries.reverse()
      return response(value)
    }
    if (url.pathname === '/mikka/api/settings/api-keys') return options.apiHttpFailure
      ? response({ error: PASSWORD + COOKIE }, 402) : response({ keys: [{ id: id(2), provider: 'deepseek' }] })
    if (url.pathname === '/mikka/api/subscriptions') return response({ connections: [
      { id: id(3), provider: 'claude', state: 'connected', paused: false },
      { id: id(4), provider: 'codex', state: 'connected', paused: false },
      ...(options.extraConnections ?? []),
    ] })
    if (url.pathname === '/mikka/api/settings/workspace-bots') return response({ bots: [{ id: id(5), ownerId: OWNER,
      status: options.busy ? 'running' : 'idle', runningThreads: options.busy ? 1 : 0, name: 'PRIVATE BOT NAME' }] })
    if (url.pathname === '/mikka/api/mobile/threads') return response({ threads: options.busy ? [{ id: id(6), status: 'running', title: 'PRIVATE TASK TITLE' }] : [] })
    if (url.pathname === '/mikka/en' || url.pathname === '/mikka/en/settings') return new Response('<script src="/mikka/_next/static/chunks/fixture.js"></script>')
    if (url.pathname === '/mikka/_next/static/chunks/fixture.js') return new Response(
      READINESS_ACTIONS.filter(name => name !== options.missingAction).map(reference).join(';')
      + ';' + reference('saveProject') + ';"https://foreign.invalid/mikka/_next/static/chunks/secret.js"')
    assert.fail('Unexpected readiness request ' + method + ' ' + url.pathname)
  }
  return { calls, order, fetchImpl, run: args => runReadiness({ env: env(), event: event(), plan: plan(), attestation: attestation(),
    fetchImpl, now: () => NOW, ...args }) }
}

test('only the existing acceptance push or a main manual readonly request is authorized', () => {
  assert.deepEqual(triggerGuard(env(), event(), plan()), { applicationSha: APP, driverRevision: DRIVER, mode: 'readonly' })
  const manualEnv = { ...env(), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' }
  assert.equal(triggerGuard(manualEnv, { repository: event().repository, inputs: { application_sha: APP } }, plan()).applicationSha, APP)
  for (const change of [{ GITHUB_REF: 'refs/heads/other' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'foreign/repo' }, { GITHUB_SHA: 'not-a-sha' }])
    assert.throws(() => triggerGuard({ ...env(), ...change }, event(), plan()), /trigger_rejected/)
  assert.throws(() => triggerGuard(env(), { ...event(), deleted: true }, plan()), /trigger_rejected/)
  assert.throws(() => triggerGuard(env(), { ...event(), after: APP }, plan()), /trigger_rejected/)
  assert.throws(() => triggerGuard(env(), event(), { ...plan(), mode: 'active' }), /plan_invalid/)
  assert.throws(() => triggerGuard(manualEnv, { repository: event().repository, inputs: { application_sha: APP, mode: 'active' } }, plan()), /trigger_rejected/)
})

test('attestation checks both exact releases before smoke credentials and never sends the GitHub token to production', async () => {
  const credentialsUnusable = new Proxy(env(), { get(target, key) { if (String(key).startsWith('SMOKE_')) assert.fail('credential read before attestation'); return target[key] } })
  const calls = []
  const actual = await attestReadiness({ env: credentialsUnusable, event: event(), plan: plan(), now: () => NOW,
    fetchImpl: async (url, init) => {
      calls.push(String(url))
      if (new URL(url).origin === 'https://api.github.com') {
        assert.equal(init.headers.authorization, 'Bearer SYNTHETIC-GITHUB-TOKEN')
        return response(String(url).includes('/jobs?') ? { jobs: publishedJobs() } : { workflow_runs: [release('web'), release('worker')] })
      }
      assert.equal(init.headers.authorization, undefined)
      return response({ build: APP })
    } })
  assert.deepEqual(actual, attestation())
  assert.equal(calls.length, 4)
})

test('a missing, pending, foreign or wrong-SHA worker is unproven rather than a forged exact release', async () => {
  for (const change of [{ head_sha: DRIVER }, { status: 'in_progress', conclusion: null },
    { head_repository: { full_name: 'foreign/repo' } }, { head_branch: 'other' }]) {
    const result = await attestReadiness({ env: env(), event: event(), plan: plan(), now: () => NOW,
      fetchImpl: async url => new URL(url).origin === 'https://api.github.com'
        ? response({ workflow_runs: [release('web'), { ...release('worker'), ...change }] }) : response({ build: APP }) })
    assert.equal(result.status, 'partial')
    assert.equal(result.runtime.status, 'unproven')
    assert.equal(result.runtime.sourceCommit, null)
    assert.equal(result.runtime.workerSha, null)
    assert.equal(result.executionReady, false)
  }
})

test('a successful hash-unchanged workflow with skipped validate/publish cannot prove a worker release', async () => {
  const skipped = publishedJobs().map(job => ({ ...job, conclusion: 'skipped', steps: [] }))
  const runtime = runtimePublicationProof(release('worker'), skipped, APP)
  assert.deepEqual(runtime, { runId: 11, sourceCommit: null, workerSha: null, status: 'not_published', code: 'publish_skipped' })
  const metadata = await fixture().run({ attestation: { ...attestation(), status: 'partial', runtime } })
  assert.equal(metadata.status, 'partial')
  assert.equal(metadata.metadataStatus, 'ready')
  assert.ok(metadata.cases.every(item => item.status === 'ready'))
  assert.equal(metadata.executionReady, false)
  assert.equal(metadata.runtime.sourceCommit, null)
  assert.equal(metadata.sessionClosed, true)
  assert.equal(Object.hasOwn(metadata, 'workerReleaseSha'), false)
})

test('publish proof requires both exact successful jobs and the actual publish step', () => {
  for (const jobs of [[], publishedJobs().map(job => ({ ...job, run_id: 99 })),
    publishedJobs().map(job => job.name === 'publish' ? { ...job, steps: [] } : job),
    publishedJobs().map(job => job.name === 'publish' ? { ...job, steps: job.steps.map(step => ({ ...step, conclusion: 'skipped' })) } : job)])
    assert.equal(runtimePublicationProof(release('worker'), jobs, APP).status, 'unproven')
  const proof = runtimePublicationProof(release('worker'), publishedJobs(), APP)
  assert.equal(proof.status, 'published')
  assert.equal(proof.sourceCommit, APP)
  assert.equal(proof.workerSha, null, 'application commit is not the worker content hash')
})

test('wrong or stale attestations reject before either account value is accessed', async () => {
  const noCredentials = new Proxy(env(), { get(target, key) { if (String(key).startsWith('SMOKE_')) assert.fail('credential access'); return target[key] } })
  for (const patch of [{ applicationSha: DRIVER }, { driverRevision: APP }, { purpose: 'other' },
    { mode: 'active' }, { checkedAt: new Date(NOW - 300001).toISOString() }, { checkedAt: new Date(NOW + 1).toISOString() }]) {
    await assert.rejects(runReadiness({ env: noCredentials, event: event(), plan: plan(), attestation: { ...attestation(), ...patch },
      now: () => NOW, fetchImpl: () => assert.fail('network before attestation') }), /attestation_required/)
  }
})

test('the HTTP boundary permits only the normal auth lifecycle and allowlisted reads', () => {
  const url = path => new URL(path, 'https://app.aspectlylabs.com')
  assert.equal(requestAllowed(url('/mikka/api/auth/sign-in/email'), 'POST'), true)
  assert.equal(requestAllowed(url('/mikka/api/auth/sign-out'), 'POST'), true)
  assert.equal(requestAllowed(url('/mikka/api/settings/model-order?workspace=' + WORKSPACE), 'GET'), true)
  for (const path of ['/mikka/api/mobile/chat', '/mikka/en', '/mikka/api/bots', '/mikka/api/factory/tasks/' + id(99), '/mikka/api/mobile/model'])
    assert.equal(requestAllowed(url(path), 'POST'), false)
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(requestAllowed(url('/mikka/api/mobile/model'), method), false)
  for (const value of ['https://foreign.invalid/mikka/api/version', 'https://user@api.github.com/mikka/api/version',
    'https://app.aspectlylabs.com/mikka/_next/static/chunks/%2e%2e/secret.js',
    'https://app.aspectlylabs.com/mikka/api/settings/model-order?workspace=' + WORKSPACE + '&extra=1'])
    assert.equal(requestAllowed(new URL(value), 'GET'), false)
})

test('normal-login metadata readiness has no task/model/settings mutation and exports no credential or content', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'ready')
  assert.equal(report.sessionClosed, true)
  assert.deepEqual(report.cases.map(item => item.status), ['ready', 'ready', 'ready'])
  assert.equal(report.order.unchanged, true)
  assert.equal(report.order.beforeSha256, report.order.afterSha256)
  assert.equal(report.paidExecutionVerified, false)
  assert.equal(report.activity.allProjectIdleVerified, false)
  assert.equal(report.activity.runtimeLeasesVerified, false)
  assert.equal(report.taskState, 'not_requested')
  assert.equal(report.taskCreationRequests, 0); assert.equal(report.preferenceMutationRequests, 0); assert.equal(report.modelCalls, 0)
  assert.equal(report.backendMaintenanceWritesMeasured, false)
  assert.equal(report.normalSessionObserved, true)
  assert.deepEqual(f.calls.filter(call => call.method !== 'GET').map(call => call.path), ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  assert.equal(f.calls.some(call => call.headers['next-action']), false)
  for (const secret of [PASSWORD, COOKIE, EMAIL, 'SYNTHETIC-GITHUB-TOKEN', 'PRIVATE BOT NAME', 'PRIVATE TASK TITLE'])
    assert.equal(JSON.stringify(report).includes(secret), false)
})

test('API metadata HTTP failure still checks each official subscription independently', async () => {
  const f = fixture({ apiHttpFailure: true }), report = await f.run()
  assert.equal(report.status, 'partial')
  assert.deepEqual(report.cases.map(item => item.status), ['blocked', 'ready', 'ready'])
  assert.equal(report.cases[0].httpStatus, 402)
  assert.equal(f.calls.filter(call => call.path.startsWith('/mikka/api/subscriptions?')).length, 2)
  assert.equal(JSON.stringify(report).includes(PASSWORD), false)
  assert.equal(report.sessionClosed, true)
})

test('reported API balance block does not substitute or skip either official model', async () => {
  const report = await fixture({ order: order => { order.entries[0].block = { reason: 'balance' } } }).run()
  assert.deepEqual(report.cases.map(item => [item.model, item.status]), [
    ['deepseek-flash', 'blocked'], ['claude-haiku-5-5', 'ready'], ['gpt-6-luna', 'ready'],
  ])
  assert.equal(report.cases[0].code, 'source_blocked')
  assert.equal(report.cases[0].block, 'balance')
})

test('an unresolved source check is not advertised as ready', async () => {
  const report = await fixture({ order: order => { order.entries[1].block = { reason: 'checking' } } }).run()
  assert.equal(report.cases[1].status, 'blocked')
  assert.equal(report.cases[1].code, 'source_checking')
  assert.equal(report.cases[2].status, 'ready')
})

test('foreign credential ownership and ambiguous subscription sources fail without a fallback', async () => {
  const foreign = await fixture({ order: order => { order.candidates[1].credentialOwnerId = 'another-owner' } }).run()
  assert.equal(foreign.cases[1].code, 'source_missing')
  assert.equal(foreign.cases[2].status, 'ready')
  const ambiguous = await fixture({ order: order => { order.candidates.push({ ...order.candidates[1],
    id: id(17), source: { kind: 'subscription', connectionId: id(7) } }) },
    extraConnections: [{ id: id(7), provider: 'claude', state: 'connected', paused: false }] }).run()
  assert.equal(ambiguous.cases[1].code, 'source_ambiguous')
  const offline = await fixture({ order: order => { order.cloudReady = false } }).run()
  assert.ok(offline.cases.every(item => item.code === 'cloud_unavailable'))
})

test('a different session or Bot owner is rejected and the new auth session is signed out', async () => {
  for (const options of [{ foreignEmail: true }, { foreignBot: true }]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'blocked')
    assert.equal(report.scope, undefined)
    assert.equal(report.sessionClosed, true)
    assert.equal(f.calls.some(call => call.path.startsWith('/mikka/api/settings/model-order')), false)
  }
})

test('existing work is reported as busy without stopping it or hiding available subscriptions', async () => {
  const f = fixture({ busy: true }), report = await f.run()
  assert.equal(report.status, 'partial')
  assert.equal(report.activity.code, 'workspace_busy')
  assert.equal(report.activity.unfinishedWorkspaceBotRuns, 1)
  assert.equal(report.activity.activeOwnThreadsReturned, 1)
  assert.ok(report.cases.every(item => item.status === 'ready'))
  assert.equal(f.calls.some(call => call.path.endsWith('/stop')), false)
  assert.equal(JSON.stringify(report).includes('PRIVATE TASK TITLE'), false)
})

test('a concurrent preference change is detected and never restored or overwritten', async () => {
  const f = fixture({ orderChanged: true }), report = await f.run()
  assert.equal(report.status, 'blocked'); assert.equal(report.code, 'order_changed')
  assert.equal(report.order.unchanged, false)
  assert.notEqual(report.order.beforeSha256, report.order.afterSha256)
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 2)
  assert.equal(report.sessionClosed, true)
})

test('published discovery requires only the three task actions and never the project actions', async () => {
  const f = fixture(), report = await f.run()
  assert.deepEqual(report.actionDiscovery.required, READINESS_ACTIONS)
  assert.deepEqual(report.actionDiscovery.found, READINESS_ACTIONS)
  assert.deepEqual(report.actionDiscovery.missing, [])
  assert.equal(report.actionDiscovery.chunksRead, 1)
  assert.equal(f.calls.some(call => call.path.includes('section=projects')), false)
  assert.equal(f.calls.some(call => call.path.includes('secret.js')), false)
  const missing = await fixture({ missingAction: 'changeModelOrder' }).run()
  assert.equal(missing.status, 'partial')
  assert.deepEqual(missing.actionDiscovery.missing, ['changeModelOrder'])
})

test('the real Next direct, bracket and member reference forms are recognized with five arguments', async () => {
  const sources = [reference('saveIssue'),
    `(0, imported["createServerReference"])("${'2'.repeat(40)}", imported.callServer, void 0, source["findSourceMapURL"], "getIssueThread")`,
    `imported.createServerReference("${'3'.repeat(40)}", callServer, undefined, findSourceMapURL, "changeModelOrder")`].join(';')
  const result = await discoverReadinessActions(async path => new Response(path.endsWith('.js') ? sources
    : '<script src="/mikka/_next/static/chunks/real.js"></script>'))
  assert.deepEqual(result.found, READINESS_ACTIONS)
})

test('deployment movement and sign-out failure cannot produce ready', async () => {
  const changed = await fixture({ buildChangeAt: 3 }).run()
  assert.equal(changed.status, 'blocked'); assert.equal(changed.code, 'build_mismatch')
  assert.equal(changed.sessionClosed, true)
  const logout = await fixture({ logoutStatus: 503 }).run()
  assert.equal(logout.status, 'blocked'); assert.equal(logout.code, 'session_close_failed')
  assert.equal(logout.sessionClosed, false)
  assert.deepEqual(publicFailure(new Error(PASSWORD)), { status: 'failed', code: 'acceptance_failed' })
})

test('the candidate workflow keeps OIDC after attestation, two named secrets, and a shared non-cancelling lock', async () => {
  const root = new URL('../../', import.meta.url)
  const workflow = await readFile(new URL('.github/workflows/production-readiness.yml', root), 'utf8')
  assert.ok(workflow.indexOf('production-readiness.mjs --attest') < workflow.indexOf('uses: Infisical/'))
  assert.equal((workflow.match(/secret-name: SMOKE_OWNER_(?:EMAIL|PASSWORD)/g) ?? []).length, 2)
  assert.match(workflow, /group: .*production-smoke-owner-acceptance/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.doesNotMatch(workflow, /run-proactive-acceptance|group-policy-preflight\.mjs|VERCEL_DEPLOY_TOKEN|mode:\s*active/)
  assert.match(workflow, /production-readiness-report\/attestation\.json\s+production-readiness-report\/report\.json/)
  for (const path of ['project-decisions-acceptance.yml', 'model-provider-fallback-acceptance.yml']) {
    const other = await readFile(new URL('.github/workflows/' + path, root), 'utf8')
    assert.match(other, /group: production-smoke-owner-acceptance\n  cancel-in-progress: false/)
  }
})
