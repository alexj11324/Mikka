import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, encode } from '../../lib/desktop-rpc/wire.ts'
import { CASES, ORIGIN, AcceptanceError, assertAttemptBudget, fixtureIdentity, openLive, preflightCase, publicFailure, runObservabilityAcceptance } from './run-observability.mjs'

const id = value => '10000000-0000-4000-8000-' + String(value).padStart(12, '0')
const revision = 'a'.repeat(40), ownerId = 'ordinary-owner', workspaceId = id(1), botId = id(2)
const env = { ACME_DEMO_EMAIL: 'private-account@example.test', ACME_DEMO_PASSWORD: 'PRIVATE_PASSWORD',
  MIKKA_EXPECTED_DEPLOYMENT_SHA: revision, MIKKA_OBSERVABILITY_MODEL_CASE: 'claude' }
const original = { id: id(9), modelId: '', provider: 'mikka', kind: 'hosted', chosen: true, available: true }
const options = CASES.map((item, index) => ({ id: id(10 + index), modelId: item.model, provider: item.provider }))
const candidates = CASES.map((item, index) => ({ id: id(20 + index), harness: item.harness, model: item.model,
  credentialOwnerId: ownerId, source: { kind: 'subscription', connectionId: id(30 + index) } }))
function inventory() {
  return { ownerId, menu: { current: original, groups: [{ kind: 'hosted', options: [original] }, { kind: 'subscription', options }] },
    order: { entries: candidates, candidates, location: 'cloud', cloudReady: true, cloudModels: Object.fromEntries(candidates.map(value => [value.id, 'ready'])) },
    connections: { connections: CASES.map((item, index) => ({ id: id(30 + index), provider: item.provider, state: 'connected', paused: false })) },
    keys: { apiKeyAfterQuota: false },
    profiles: { profiles: [], catalog: { models: candidates.map(value => ({ ...value, available: true })) } } }
}
function fixture({ failure, profileBusy = false } = {}) {
  const calls = [], profiles = new Map(), submissions = [], cancelled = new Set()
  let current = { ...original }, closed = 0, liveClosed = 0
  const response = (value, status = 200, headers) => Response.json(value, { status, headers })
  const runData = runId => {
    const submission = submissions.find(value => value.runs.includes(runId))
    assert.ok(submission)
    return { submission, run: { id: runId, botId, issueId: submission.issueId, status: 'succeeded',
      model: submission.item.model, harness: submission.item.harness, credentialType: 'subscription',
      subscriptionRoute: submission.item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli',
      agentProfile: { profileId: submission.profileId, version: 1 },
      executionIdentity: { version: 1, requester: ownerId, executionPrincipal: ownerId, outputOwner: ownerId, botOwner: ownerId, botId, workspaceId,
        personalResourcePolicy: 'requester_only', billingAccount: { model: { kind: 'subscription', ownerId, resourceId: id(70) }, runtime: { kind: 'e2b', ownerId } },
        resourceBindings: [{ kind: 'subscription', id: id(70), ownerId, access: 'owner' }] } } }
  }
  const chat = () => ({ botId, enabled: true, working: false, cursor: 10 + submissions.length * 2,
    items: submissions.flatMap((value, index) => [
      { position: 11 + index * 2, from: 'person', text: value.prompt },
      { position: 12 + index * 2, from: 'coordinator', text: 'PRIVATE_RESPONSE', streamId: 'wrun_abcdefghijklmnop' + index + ':1' },
    ]), sources: Object.fromEntries(submissions.map(value => [value.issueId, { kind: 'issue', id: value.issueId }])) })
  async function fetchImpl(input, init = {}) {
    const url = new URL(input), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined
    assert.equal(url.origin, ORIGIN)
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    calls.push({ path: url.pathname, method, body, headers: Object.fromEntries(init.headers ?? []) })
    const path = url.pathname.replace(/^\/mikka/, '')
    if (path === '/api/version') return response({ build: failure === 'build' ? 'b'.repeat(40) : revision })
    if (path === '/api/auth/sign-in/email') {
      assert.equal(body.password, env.ACME_DEMO_PASSWORD)
      return response({ token: 'PRIVATE_TOKEN' }, 200, { 'set-cookie': 'better-auth.session_token=PRIVATE_COOKIE; Path=/mikka; Secure; HttpOnly' })
    }
    if (path === '/api/auth/sign-out') { closed++; return response({ ok: true }) }
    assert.match(new Headers(init.headers).get('cookie'), /PRIVATE_COOKIE/)
    if (path === '/api/auth/get-session') return response({ user: { id: ownerId, email: env.ACME_DEMO_EMAIL }, session: { id: 'PRIVATE_AUTH_SESSION' } })
    if (path === '/api/workspace') return response({ workspace: { id: workspaceId, kind: 'personal' }, currentUserId: ownerId, role: 'admin' })
    if (path === '/api/coordinator/messages') return response(chat())
    if (path === '/api/settings/workspace-bots') return response({ bots: [{ status: 'idle', runningThreads: failure === 'busy' ? 1 : 0 }] })
    if (path === '/api/mobile/threads') return response({ threads: submissions.flatMap(value => value.runs.map(runId => ({ id: runId, status: 'done' }))) })
    if (path === '/api/mobile/tasks') return response({ tasks: submissions.map(value => ({ id: value.issueId, title: value.marker })) })
    if (path === '/api/mobile/model' && method === 'GET') {
      if (failure === 'concurrent_model' && submissions.length) current = { ...original, id: id(999) }
      return response({ ...inventory().menu, current })
    }
    if (path === '/api/mobile/model' && method === 'PUT') {
      const option = [original, ...options].find(value => value.id === body.id)
      assert.ok(option)
      current = { ...option, kind: option.id === original.id ? 'hosted' : 'subscription', chosen: true, available: true }
      if (failure === 'lost_model_response' && body.id !== original.id) throw new Error('PRIVATE_NETWORK_ERROR')
      return response({ ...inventory().menu, current })
    }
    if (path === '/api/settings/model-order') return response(inventory().order)
    if (path === '/api/subscriptions') return response(inventory().connections)
    if (path === '/api/settings/api-keys') return response({ apiKeyAfterQuota: failure === 'paid_fallback', keys: [{ name: 'PRIVATE_KEY_NAME' }] })
    if (path === '/api/factory/agent-profiles' && method === 'GET') {
      const active = [...profiles.values()].filter(value => !value.archivedAt)
      return response({ ...inventory().profiles, profiles: profileBusy ? [{ id: id(99), enabled: true }] : active,
        availability: Object.fromEntries(active.map(value => [value.id, { available: true }])) })
    }
    if (path === '/api/factory/agent-profiles' && method === 'POST') {
      const value = { ...body.profile, id: body.requestId, version: 1, archivedAt: null }
      profiles.set(value.id, value)
      if (failure === 'lost_profile_response') throw new Error('PRIVATE_NETWORK_ERROR')
      return response({ profile: value }, 201)
    }
    if (path.startsWith('/api/factory/agent-profiles/')) {
      const value = profiles.get(path.split('/').at(-1))
      if (!value) return response({ error: 'agentProfileNotFound' }, 404)
      if (method === 'DELETE') {
        assert.equal(body.version, value.version)
        value.archivedAt = '2026-11-06T00:00:00.000Z'; value.enabled = false; value.version++
      }
      return response({ profile: value })
    }
    if (path === '/api/rpc') {
      const args = decode(body.args)
      if (body.action === 'coordinator.sendCoordinatorMessage') {
        const profileId = args[8], profile = profiles.get(profileId), item = CASES.find(value => value.model === profile.model.model)
        assert.equal(args[2], botId); assert.equal(args[3], profileId); assert.deepEqual(args[4], { kind: 'cloud' })
        const index = submissions.length
        submissions.push({ ...fixtureIdentity(revision, item), item, profileId, prompt: args[0], issueId: id(100 + index), taskId: id(200 + index),
          candidateId: id(300 + index), artifactId: id(500 + index), eventId: id(600 + index),
          runs: Array.from({ length: failure === 'budget' ? 4 : 3 }, (_, offset) => id(400 + index * 10 + offset)) })
        if (failure === 'lost_submission_response') throw new Error('PRIVATE_NETWORK_ERROR')
        return response({ ok: true, result: encode({ queued: true }) })
      }
      assert.equal(body.action, 'issues.getIssue')
      const found = submissions.find(value => value.issueId === args[0]); assert.ok(found)
      return response({ ok: true, result: encode({ issue: { id: found.issueId, userId: ownerId, title: found.marker } }) })
    }
    if (path === '/api/mobile/bots/' + botId) return response({ threads: submissions.flatMap(value => value.runs.map(runId => ({ id: runId, status: 'done' }))) })
    if (path === '/api/factory/tasks') {
      const found = submissions.find(value => value.issueId === url.searchParams.get('issueId'))
      return response({ tasks: found ? [{ id: found.taskId, stage: 'verify', status: cancelled.has(found.taskId) ? 'cancelled' : 'passed' }] : [] })
    }
    if (path.startsWith('/api/factory/tasks/')) {
      const found = submissions.find(value => value.taskId === path.split('/').at(-1)); assert.ok(found)
      if (method === 'POST') { assert.equal(body.action, 'cancel'); cancelled.add(found.taskId) }
      return response({ task: { id: found.taskId, issueId: found.issueId, userId: ownerId, botId, stage: 'verify',
        status: cancelled.has(found.taskId) ? 'cancelled' : 'passed', revision: 1, candidateId: found.candidateId, sourceEventId: found.eventId },
        attempts: found.runs.map((runId, index) => ({ runId, stage: ['execute', 'review', 'verify', 'execute'][index], status: 'passed',
          candidateId: found.candidateId, output: { requestEpoch: found.eventId } })),
        candidates: [{ id: found.candidateId, runId: found.runs[0] }] })
    }
    if (/^\/api\/runs\/[^/]+\/evidence$/.test(path)) {
      const { run, submission } = runData(path.split('/')[3])
      if (failure === 'wrong_model') run.model = 'unexpected-private-model'
      return response({ run, artifacts: [{ id: submission.artifactId, title: submission.marker + '.txt', latestVersion: 1,
        url: '/mikka/api/artifacts/' + submission.artifactId + '/versions/1/download' }], captures: [] })
    }
    if (path.startsWith('/api/artifacts/')) {
      const found = submissions.find(value => value.artifactId === path.split('/')[3]); assert.ok(found)
      return new Response('mikka-observability:' + found.marker + '\nstatus=ready\n')
    }
    throw new Error('Unexpected fixture route')
  }
  return { calls, profiles, submissions, fetchImpl,
    openLiveImpl: async () => ({ revision: 0, wait: async () => { throw new AcceptanceError('task_timeout') }, close: () => { liveClosed++ } }),
    get state() { return { closed, liveClosed, current, cancelled } } }
}
const run = (data, execute = false, overrides = {}) => runObservabilityAcceptance({ env: { ...env, ...overrides }, execute,
  fetchImpl: data.fetchImpl, openLiveImpl: data.openLiveImpl })
const safe = report => assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|private-account|example\.test|prompt|COOKIE|TOKEN/)

test('preflight reads both exact subscription paths without creating profiles, changing settings or submitting tasks', async () => {
  const data = fixture(), report = await run(data, false, { MIKKA_OBSERVABILITY_MODEL_CASE: 'all' })
  assert.equal(report.status, 'ready'); assert.equal(report.cases.length, 2)
  assert.deepEqual(data.calls.filter(value => value.method !== 'GET').map(value => value.path), ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  assert.equal(data.submissions.length, 0); assert.equal(data.profiles.size, 0); assert.equal(data.state.closed, 1)
  safe(report)
})
test('unsafe configuration blocks before any model call and reports only closed failure codes', async () => {
  for (const [failure, code] of [['busy', 'workspace_busy'], ['paid_fallback', 'paid_fallback_enabled'], ['build', 'build_mismatch']]) {
    const data = fixture({ failure }), report = await run(data, true)
    assert.equal(report.status, 'blocked'); assert.equal(report.code ?? report.cases[0].code, code)
    assert.equal(data.submissions.length, 0); assert.equal(data.profiles.size, 0); safe(report)
  }
  const data = fixture({ profileBusy: true }), report = await run(data, true)
  assert.equal(report.cases[0].code, 'profiles_active'); assert.equal(data.submissions.length, 0)
  const invalid = fixture()
  await assert.rejects(run(invalid, true, { MIKKA_OBSERVABILITY_MODEL_CASE: 'deepseek' }), /configuration_required/)
  assert.equal(invalid.calls.length, 0)
})
test('two executed cases retain exact native receipts, restore model/profile state and never fabricate replay evidence', async () => {
  const data = fixture(), report = await run(data, true, { MIKKA_OBSERVABILITY_MODEL_CASE: 'all' })
  assert.equal(report.status, 'runtime_verified', JSON.stringify(report))
  assert.equal(data.submissions.length, 2)
  assert.deepEqual(data.state.current, original)
  assert.ok([...data.profiles.values()].every(value => value.archivedAt && !value.enabled))
  for (const value of report.cases) {
    assert.equal(value.runs.length, 3); assert.equal(value.checks.length, 2)
    assert.equal(value.cleanup.evidence, 'retained'); assert.equal(value.cleanup.state, 'complete')
    assert.equal(value.artifact.bytes > 0, true)
    assert.match(value.requestTrace.traceId, /^[0-9a-f]{32}$/)
    assert.equal(value.requestTrace.backendObserved, false)
  }
  for (const call of data.calls.filter(value => value.body?.action === 'coordinator.sendCoordinatorMessage')) {
    assert.match(call.headers.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/)
    assert.equal(call.headers['x-posthog-session-id'], undefined)
  }
  assert.equal(report.browserReplayVerified, false); assert.equal(report.posthogIngestionVerified, false)
  assert.equal(data.calls.filter(value => value.method === 'DELETE' && !value.path.includes('/agent-profiles/')).length, 0)
  safe(report)
})
test('uncertain mutation responses never resubmit and still reconcile own temporary settings', async () => {
  for (const failure of ['lost_profile_response', 'lost_model_response', 'lost_submission_response']) {
    const data = fixture({ failure }), report = await run(data, true)
    assert.equal(report.status, 'blocked'); assert.equal(report.cases[0].code, 'request_failed', JSON.stringify(report))
    assert.equal(report.cases[0].cleanup.state, 'complete', JSON.stringify(report))
    assert.ok([...data.profiles.values()].every(value => value.archivedAt))
    assert.deepEqual(data.state.current, original)
    assert.equal(data.submissions.length, failure === 'lost_submission_response' ? 1 : 0)
    safe(report)
  }
})
test('wrong provider/model and an extra native attempt stop the case without retrying', async () => {
  for (const [failure, code] of [['wrong_model', 'run_model'], ['budget', 'budget_exceeded']]) {
    const data = fixture({ failure }), report = await run(data, true)
    assert.equal(report.cases[0].code, code, JSON.stringify(report))
    assert.equal(report.cases[0].cleanup.state, 'complete')
    assert.equal(data.submissions.length, 1)
    assert.equal(data.state.cancelled.size, 1)
    safe(report)
  }
})
test('pure source and budget guards reject shared credentials, inherited model choices and retries', () => {
  const source = inventory(); source.order.candidates = source.order.candidates.map(value => ({ ...value, credentialOwnerId: 'someone-else' }))
  assert.throws(() => preflightCase(CASES[0], source), /source_missing/)
  const inherited = inventory(); inherited.menu.current = { ...original, chosen: false }
  assert.throws(() => preflightCase(CASES[0], inherited), /model_not_restorable/)
  assert.throws(() => assertAttemptBudget([{ runId: id(1), stage: 'execute' }, { runId: id(2), stage: 'execute' }]), /budget_exceeded/)
  assert.deepEqual(publicFailure(new Error('PRIVATE_PASSWORD PRIVATE_COOKIE')), { status: 'blocked', code: 'acceptance_failed' })
})
test('cleanup preserves a concurrent model edit and reports incomplete restoration', async () => {
  const data = fixture({ failure: 'concurrent_model' }), report = await run(data, true)
  assert.equal(report.cases[0].code, 'cleanup_incomplete')
  assert.equal(report.cases[0].cleanup.modelError.code, 'model_changed')
  assert.equal(data.state.current.id, id(999))
  assert.equal(data.calls.filter(value => value.method === 'PUT').length, 1)
  assert.equal(data.submissions.length, 1)
  safe(report)
})
test('live transport waits for actual invalidations, rejects disconnects and keeps capabilities out of reports', async () => {
  let socket
  const live = await openLive(async () => ({ url: 'wss://gateway.example.test/v1/live/' + 'b'.repeat(64) + '/socket',
    protocol: 'PRIVATE_LIVE_CAPABILITY', expiresAt: Date.now() + 120_000 }), workspaceId, {
    socketFactory: () => {
      socket = { send() {}, close() {} }
      queueMicrotask(() => socket.onmessage({ data: JSON.stringify({ type: 'live_ready', version: 2,
        kinds: ['bot_chat', 'run', 'factory_task', 'factory_issue'], revisions: ['bot_chat', 'run'] }) }))
      return socket
    },
  })
  const pending = live.wait(live.revision, Date.now() + 1000)
  socket.onmessage({ data: JSON.stringify({ kind: 'run', id: id(1), rev: 1 }) })
  await pending
  assert.equal(live.revision, 2)
  socket.onclose()
  await assert.rejects(live.wait(live.revision, Date.now() + 1000), /live_disconnected/)
  live.close()
})
