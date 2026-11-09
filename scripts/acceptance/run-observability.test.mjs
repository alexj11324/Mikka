import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, encode } from '../../lib/desktop-rpc/wire.ts'
import { CASES, ORIGIN, AcceptanceError, assertAttemptBudget, browserSubmissionText, fixtureIdentity, fixtureTask, issueInventory, openLive, preflightCase, publicFailure, runObservabilityAcceptance } from './run-observability.mjs'

const id = value => '10000000-0000-4000-8000-' + String(value).padStart(12, '0')
const revision = 'a'.repeat(40), ownerId = 'ordinary-owner', workspaceId = id(1), botId = id(2), teamId = id(3)
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
const existingProfile = { id: id(99), version: 3, digest: '3'.repeat(64), archivedAt: null, name: 'PRIVATE_PROFILE_NAME',
  description: 'PRIVATE_DESCRIPTION', enabled: true, harness: 'claude_code', model: { mode: 'inherit' }, effort: 'low', roles: [],
  skills: ['private-skill'], instructions: 'PRIVATE_INSTRUCTIONS' }
function fixture({ failure, machineFailure, baselineRuns = [], profileBusy = false, paidFallback = false, flowVersion = 2, teamDefault = false, workspaceView = value => value,
  historicalTask = null, historicalDetail = value => value, implicitDefault = false } = {}) {
  const calls = [], profiles = new Map(), submissions = [], foreignMessages = [], cancelled = new Set(), accepted = new Set(), machineEnds = new Set()
  const stages = flowVersion === 2 ? ['execute', 'review'] : ['execute', 'review', 'verify']
  const historical = historicalTask && { id: id(901), issueId: id(902), revision: 7, stage: 'execute', status: 'blocked',
    attemptId: id(903), candidateId: null, ...historicalTask }
  if (profileBusy) profiles.set(existingProfile.id, structuredClone(existingProfile))
  let current = { ...original, ...(implicitDefault ? { chosen: false } : {}) }, storedPreference = !implicitDefault, temporarySelection, closed = 0, liveClosed = 0, fallback = paidFallback || failure === 'paid_fallback', concurrentEdit = false
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
  function supplySubmission(profileId, prompt) {
    const profile = profiles.get(profileId), item = CASES.find(value => value.model === profile.model.model), index = submissions.length
    submissions.push({ ...fixtureIdentity(revision, item), item, profileId, prompt, issueId: id(100 + index), taskId: id(200 + index),
      candidateId: id(300 + index), artifactId: id(500 + index), eventId: id(600 + index), attemptId: id(700 + index), acceptanceId: id(800 + index),
      runs: Array.from({ length: stages.length + (failure === 'budget' ? 1 : 0) }, (_, offset) => id(400 + index * 10 + offset)) })
  }
  const chat = () => ({ botId, enabled: true, working: false, cursor: 10 + submissions.length * 2,
    items: submissions.flatMap((value, index) => [
      { position: 11 + index * 2, from: 'person', text: value.prompt },
      { position: 12 + index * 2, from: 'coordinator', text: 'PRIVATE_RESPONSE', streamId: 'wrun_abcdefghijklmnop' + index + ':1' },
    ]).concat(foreignMessages), sources: Object.fromEntries(submissions.map(value => [value.issueId, { kind: 'issue', id: value.issueId }])) })
  const threads = () => [...baselineRuns, ...submissions.flatMap(value => value.runs)].map(runId => ({ id: runId, status: 'done' }))
  async function fetchImpl(input, init = {}) {
    const url = new URL(input), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined
    assert.equal(url.origin, ORIGIN)
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    calls.push({ path: url.pathname, search: url.search, method, body, headers: Object.fromEntries(init.headers ?? []) })
    const path = url.pathname.replace(/^\/mikka/, '')
    if (path === '/api/version') return response({ build: failure === 'build' ? 'b'.repeat(40) : revision })
    if (path === '/api/auth/sign-in/email') {
      assert.equal(body.password, env.ACME_DEMO_PASSWORD)
      return response({ token: 'PRIVATE_TOKEN' }, 200, { 'set-cookie': 'better-auth.session_token=PRIVATE_COOKIE; Path=/mikka; Secure; HttpOnly' })
    }
    if (path === '/api/auth/sign-out') { closed++; return response({ ok: true }) }
    assert.match(new Headers(init.headers).get('cookie'), /PRIVATE_COOKIE/)
    if (path === '/api/auth/get-session') return response({ user: { id: ownerId, email: env.ACME_DEMO_EMAIL }, session: { id: 'PRIVATE_AUTH_SESSION' } })
    if (path === '/api/workspace') {
      const saved = new Headers(init.headers).get('cookie').includes('mikka-workspace=' + workspaceId)
      if (failure === 'workspace_readback_failed' && saved && !url.search) return response({ error: 'PRIVATE_WORKSPACE_FAILURE' }, 503)
      const selected = url.searchParams.get('workspace') ?? (saved || !teamDefault ? workspaceId : teamId)
      const personal = { id: workspaceId, kind: 'personal', name: 'PRIVATE_PERSONAL_NAME' }
      const team = { id: teamId, kind: 'team', name: 'PRIVATE_TEAM_NAME' }
      return response(workspaceView({ workspace: selected === workspaceId ? personal : team, choices: [team, personal],
        currentUserId: ownerId, role: 'admin', members: [{ userId: ownerId, role: 'admin', status: 'active', email: env.ACME_DEMO_EMAIL }] }))
    }
    if (path === '/api/coordinator/messages') return response(chat())
    if (path === '/api/settings/workspace-bots') return response({ bots: [{ status: 'idle', runningThreads: failure === 'busy' ? 1 : 0 }] })
    if (path === '/api/mobile/threads') return response({ threads: threads() })
    if (path === '/api/mobile/tasks') return response({ tasks: submissions.map(value => ({ id: value.issueId, title: value.marker })) })
    if (path === '/api/issues/search') return response({ items: [...(historical ? [historical] : []), ...submissions].map(value => ({ id: value.issueId, revision: 1, updatedAt: '2026-11-06T00:00:00.000Z' })), nextCursor: null, truncated: false })
    if (path === '/api/mobile/model' && method === 'GET') {
      if (failure === 'concurrent_model' && submissions.length) current = { ...original, id: id(999) }
      if (failure === 'unchosen') current.chosen = false
      return response({ ...inventory().menu, current, ...(url.searchParams.get('choiceState') === '1'
        ? { preferenceState: storedPreference ? 'present' : 'absent' } : {}) })
    }
    if (path === '/api/mobile/model' && method === 'PUT') {
      if (body.mode === 'restore-implicit') {
        assert.ok(temporarySelection, 'only an acknowledged temporary selection may be restored')
        assert.deepEqual(body, { bot: botId, mode: 'restore-implicit', ...temporarySelection })
        if (failure === 'temporary_same_value_edit') return response({ error: 'modelChanged' }, 409)
        storedPreference = false; current = { ...original, chosen: false }
        if (failure === 'temporary_restore_lost') throw new Error('PRIVATE_NETWORK_ERROR')
        return response({ restored: true, preferenceState: 'absent' })
      }
      if (body.mode === 'temporary-if-absent') {
        assert.equal(body.bot, botId)
        if (failure === 'temporary_preflight_race') storedPreference = true
        if (storedPreference) return response({ error: 'modelChanged' }, 409)
        assert.equal(body.id, options[0].id)
        storedPreference = true
        temporarySelection = { bindingId: id(991), revision: '12345' }
        current = { ...options[0], kind: 'subscription', chosen: true, available: true }
        if (failure === 'temporary_select_lost') throw new Error('PRIVATE_NETWORK_ERROR')
        return response({ ...inventory().menu, current, ...(failure === 'temporary_receipt_missing' ? {} : { temporarySelection }) })
      }
      const option = [original, ...options].find(value => value.id === body.id)
      assert.ok(option)
      current = { ...option, kind: option.id === original.id ? 'hosted' : 'subscription', chosen: true, available: true }
      if (failure === 'lost_model_response' && body.id !== original.id) throw new Error('PRIVATE_NETWORK_ERROR')
      return response({ ...inventory().menu, current })
    }
    if (path === '/api/settings/model-order') {
      const order = inventory().order
      if (failure === 'claude_blocked') order.entries = order.entries.map(value => value.harness === 'claude_code' ? { ...value, block: 'quota' } : value)
      return response(order)
    }
    if (path === '/api/subscriptions') return response(inventory().connections)
    if (path === '/api/settings/api-keys') {
      if (failure === 'concurrent_fallback' && submissions.length) fallback = true
      return response({ apiKeyAfterQuota: fallback, keys: [{ name: 'PRIVATE_KEY_NAME' }] })
    }
    if (path === '/api/factory/agent-profiles' && method === 'GET') {
      const active = [...profiles.values()].filter(value => !value.archivedAt)
      return response({ ...inventory().profiles, profiles: active,
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
      if (value.id === existingProfile.id && failure === 'concurrent_profile' && submissions.length && !concurrentEdit) {
        value.instructions = 'PRIVATE_CONCURRENT_EDIT'; value.version++; value.digest = 'f'.repeat(64); concurrentEdit = true
      }
      if (method === 'PATCH') {
        if (body.version !== value.version || failure === 'prepare_profile_refused' && !body.profile.enabled
          || failure === 'restore_profile_refused' && body.profile.enabled) return response({ error: 'agentProfileVersionConflict' }, 409)
        Object.assign(value, body.profile, { version: value.version + 1, digest: String(value.version + 1).repeat(64).slice(0, 64) })
        if (failure === 'prepare_profile_lost' && !body.profile.enabled) throw new Error('PRIVATE_NETWORK_ERROR')
      }
      if (method === 'DELETE') {
        assert.equal(body.version, value.version)
        value.archivedAt = '2026-11-06T00:00:00.000Z'; value.enabled = false; value.version++
      }
      return response({ profile: value })
    }
    if (path === '/api/rpc') {
      const args = decode(body.args)
      if (body.action === 'workspace.switchWorkspace') {
        assert.deepEqual(args, [{ workspaceId, accountId: ownerId }])
        return response({ ok: true, result: encode({ ok: true, data: { workspaceId: failure === 'workspace_switch_mismatch' ? teamId : workspaceId } }) }, 200,
          failure === 'workspace_cookie_missing' ? undefined : { 'set-cookie': 'mikka-workspace=' + workspaceId + '; Path=/; Secure; HttpOnly; SameSite=Lax' })
      }
      if (body.action === 'task-runs.pollThreads' || body.action === 'task-runs.pollTaskRuns') {
        const busy = failure === 'owner_busy' || failure === 'owner_busy_restore' && submissions.length
        return response({ ok: true, result: encode({ items: busy ? [{ id: id(909), status: 'running', prompt: 'PRIVATE_OTHER_WORKSPACE' }] : [] }) })
      }
      if (body.action === 'model-api-keys.updateApiKeyAfterQuota') {
        assert.deepEqual(args, [!fallback, workspaceId])
        if (failure === 'restore_fallback_refused' && args[0]) return response({ error: 'subscriptionConflict' }, 409)
        fallback = args[0]
        if (failure === 'prepare_fallback_lost' && !fallback) throw new Error('PRIVATE_NETWORK_ERROR')
        return response({ ok: true, result: encode({ apiKeyAfterQuota: fallback }) })
      }
      if (body.action === 'coordinator.sendCoordinatorMessage') {
        const profileId = args[8]
        assert.equal(args[2], botId); assert.equal(args[3], profileId); assert.deepEqual(args[4], { kind: 'cloud' })
        supplySubmission(profileId, args[0])
        if (failure === 'lost_submission_response') throw new Error('PRIVATE_NETWORK_ERROR')
        return response({ ok: true, result: encode({ queued: true }) })
      }
      assert.equal(body.action, 'issues.getIssue')
      const found = submissions.find(value => value.issueId === args[0]); assert.ok(found)
      return response({ ok: true, result: encode({ issue: { id: found.issueId, userId: ownerId, title: found.marker } }) })
    }
    if (path === '/api/mobile/bots/' + botId) return response({ threads: threads() })
    if (/^\/api\/threads\/[^/]+\/machine$/.test(path)) {
      const runId = path.split('/')[3], { submission } = runData(runId)
      assert.equal(method, 'POST'); assert.deepEqual(body, { action: 'end' })
      assert.ok(accepted.has(submission.taskId) || cancelled.has(submission.taskId), 'machines end only after the Factory task settles')
      assert.equal(machineEnds.has(runId), false, 'an uncertain end is not blindly repeated')
      machineEnds.add(runId)
      if (runId === submissions[0].runs[0]) {
        if (machineFailure === 'timeout') throw new DOMException('PRIVATE_MACHINE_TIMEOUT', 'TimeoutError')
        if (['missing', 'missing_scope', 'missing_ended', 'missing_invalid'].includes(machineFailure)) return response({ error: 'Thread unavailable' }, 404)
        if (machineFailure === 'conflict') return response({ error: 'Thread creation cleanup pending' }, 409)
        if (machineFailure === 'unavailable') return response({ error: 'PRIVATE_PROVIDER_FAILURE' }, 503)
        if (machineFailure === 'invalid') return new Response('PRIVATE_INVALID_MACHINE_RESPONSE')
        if (machineFailure === 'wrong_id') return response({ runId: id(999), state: 'ended' })
        if (machineFailure === 'wrong_state') return response({ runId, state: 'paused' })
        if (machineFailure === 'wrong_status') return response({ runId, state: 'ended' }, 202)
      }
      return response({ runId, state: 'ended' })
    }
    if (/^\/api\/mobile\/threads\/[^/]+\/machine$/.test(path)) {
      const runId = path.split('/')[4]; runData(runId)
      assert.equal(method, 'GET'); assert.ok(machineEnds.has(runId))
      return response(machineFailure === 'missing_invalid' ? {} : { machine: machineFailure === 'missing_ended'
        ? { kind: 'cloud', state: 'ended', cloud: null } : null })
    }
    if (path === '/api/factory/tasks') {
      if (historical?.issueId === url.searchParams.get('issueId')) return response({ contractVersion: 1,
        issueId: historical.issueId, liveWorkspaceId: workspaceId, tasks: [historical] })
      const found = submissions.find(value => value.issueId === url.searchParams.get('issueId'))
      return response({ tasks: found ? [{ id: found.taskId, stage: 'approval', candidateId: found.candidateId, candidateSha: null,
        status: cancelled.has(found.taskId) ? 'cancelled' : accepted.has(found.taskId) ? 'passed' : 'pending' }] : [] })
    }
    if (/^\/api\/factory\/tasks\/[^/]+\/approval$/.test(path)) {
      const found = submissions.find(value => value.taskId === path.split('/')[4]); assert.ok(found)
      assert.equal(method, 'POST')
      const binding = { taskId: found.taskId, issueId: found.issueId, attemptId: found.attemptId, candidateId: found.candidateId, revision: 1 }
      assert.deepEqual(body, { operation: 'accept', input: { binding, eventId: found.profileId } })
      assert.equal(accepted.has(found.taskId), false)
      if (failure === 'approval_refused') return response({ error: 'factoryStale' }, 409)
      accepted.add(found.taskId)
      if (failure === 'lost_acceptance_response') throw new Error('PRIVATE_NETWORK_ERROR')
      return response({ status: 'accepted', acceptanceId: found.acceptanceId, binding: { ...binding, revision: 2 } })
    }
    if (path.startsWith('/api/factory/tasks/')) {
      if (historical && path === '/api/factory/tasks/' + historical.id) {
        assert.equal(method, 'GET', 'historical tasks must never be changed')
        return response(historicalDetail({ task: { ...historical, userId: ownerId, botId: id(904) }, liveWorkspaceId: id(905) }))
      }
      const found = submissions.find(value => value.taskId === path.split('/').at(-1)); assert.ok(found)
      if (method === 'POST') { assert.equal(body.action, 'cancel'); cancelled.add(found.taskId) }
      const complete = accepted.has(found.taskId)
      const attempts = found.runs.map((runId, index) => ({ runId, stage: stages[index] ?? 'execute',
        status: failure === 'review_failed' && stages[index] === 'review' ? 'failed' : 'passed', candidateId: found.candidateId,
        output: { requestEpoch: failure === 'review_stale' && stages[index] === 'review' ? id(999) : found.eventId } }))
        .filter(value => failure !== value.stage + '_missing')
      if (complete) attempts.push({ id: found.attemptId, runId: null, stage: 'approval', candidateId: found.candidateId,
        status: 'passed', output: { requestEpoch: found.eventId, ...(failure === 'acceptance_receipt_missing' ? {} : { deliverableAcceptanceId: found.acceptanceId }) } })
      return response({ task: { id: found.taskId, issueId: found.issueId, userId: ownerId, botId, stage: 'approval',
        status: cancelled.has(found.taskId) ? 'cancelled' : complete ? 'passed' : 'pending', revision: complete ? 2 : 1,
        attemptId: found.attemptId, candidateId: found.candidateId, sourceEventId: found.eventId, ...(flowVersion === 2 ? { route: { flowVersion: 2 } } : {}) },
        attempts, candidates: [{ id: found.candidateId, runId: found.runs[0], repository: failure === 'repository_candidate' ? 'owner/repo' : 'none',
          kind: failure === 'repository_candidate' ? 'repository' : 'deliverable', sha: failure === 'repository_candidate' ? revision : null }] })
    }
    if (/^\/api\/runs\/[^/]+\/evidence$/.test(path)) {
      const { run, submission } = runData(path.split('/')[3])
      if (failure === 'wrong_model') run.model = 'unexpected-private-model'
      if (machineFailure === 'missing_scope' && machineEnds.has(run.id)) run.executionIdentity.requester = 'PRIVATE_OTHER_OWNER'
      return response({ run, artifacts: [{ id: submission.artifactId, title: submission.marker + '.txt', latestVersion: 1,
        url: '/mikka/api/artifacts/' + submission.artifactId + '/versions/1/download' }], captures: [] })
    }
    if (path.startsWith('/api/artifacts/')) {
      const found = submissions.find(value => value.artifactId === path.split('/')[3]); assert.ok(found)
      return new Response('mikka-observability:' + found.marker + '\nstatus=ready\n')
    }
    throw new Error('Unexpected fixture route')
  }
  return { calls, profiles, submissions, foreignMessages, supplySubmission, fetchImpl,
    openLiveImpl: async () => ({ revision: 0, wait: async () => { throw new AcceptanceError('task_timeout') }, close: () => { liveClosed++ } }),
    get state() { return { closed, liveClosed, current, storedPreference, cancelled, accepted, fallback } } }
}
const run = (data, execute = false, overrides = {}, settings = {}) => runObservabilityAcceptance({ env: { ...env, ...overrides }, execute,
  fetchImpl: data.fetchImpl, openLiveImpl: data.openLiveImpl, ...settings })
const safe = report => assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|private-account|example\.test|prompt|COOKIE|TOKEN/)

test('preflight reads both exact subscription paths without creating profiles, changing settings or submitting tasks', async () => {
  const data = fixture(), report = await run(data, false, { MIKKA_OBSERVABILITY_MODEL_CASE: 'all' })
  assert.equal(report.status, 'ready'); assert.equal(report.cases.length, 2)
  assert.equal(report.workspaceId, workspaceId); assert.equal(report.workspaceSelection, 'current_personal')
  assert.deepEqual(data.calls.filter(value => value.method !== 'GET').map(value => value.path), ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  assert.equal(data.submissions.length, 0); assert.equal(data.profiles.size, 0); assert.equal(data.state.closed, 1)
  safe(report)
})

test('preflight excludes only a version-bound Factory task proven to belong to another workspace', async () => {
  const data = fixture({ historicalTask: {} }), report = await run(data)
  assert.equal(report.status, 'ready', JSON.stringify(report))
  assert.equal(data.calls.filter(call => call.path === '/mikka/api/factory/tasks/' + id(901)).length, 1)
  assert.deepEqual(data.calls.filter(call => call.method !== 'GET').map(call => call.path),
    ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  assert.equal(data.submissions.length, 0); assert.equal(data.state.cancelled.size, 0); assert.equal(data.state.closed, 1); safe(report)
})
test('preflight keeps same-workspace, missing and mismatched Factory scope proofs blocked', async () => {
  const guards = [
    value => ({ ...value, liveWorkspaceId: workspaceId }),
    value => ({ ...value, liveWorkspaceId: null }),
    value => ({ task: value.task }),
    value => ({ ...value, liveWorkspaceId: 'PRIVATE_WORKSPACE' }),
    value => ({ ...value, task: { ...value.task, id: id(906) } }),
    value => ({ ...value, task: { ...value.task, issueId: id(906) } }),
    value => ({ ...value, task: { ...value.task, userId: 'PRIVATE_OTHER_OWNER' } }),
    value => ({ ...value, task: { ...value.task, revision: 8 } }),
    value => ({ ...value, task: { ...value.task, revision: undefined, version: 7 } }),
    value => ({ ...value, task: { ...value.task, stage: 'review' } }),
    value => ({ ...value, task: { ...value.task, status: 'running' } }),
    value => ({ ...value, task: { ...value.task, attemptId: id(906) } }),
    value => ({ ...value, task: { ...value.task, candidateId: id(906) } }),
  ]
  for (const [index, historicalDetail] of guards.entries()) {
    const data = fixture({ historicalTask: {}, historicalDetail }), report = await run(data)
    assert.equal(report.status, 'blocked', String(index))
    assert.equal(report.cases[0].code, 'workspace_busy', String(index))
    assert.equal(data.submissions.length, 0); assert.equal(data.state.cancelled.size, 0); assert.equal(data.state.closed, 1); safe(report)
  }
})
test('preflight does not convert current-workspace failed or blocked Factory tasks into terminal tasks', async () => {
  for (const status of ['failed', 'blocked']) {
    const data = fixture({ historicalTask: { status }, historicalDetail: value => ({ ...value, liveWorkspaceId: workspaceId }) })
    const report = await run(data)
    assert.equal(report.status, 'blocked'); assert.equal(report.cases[0].code, 'workspace_busy')
    assert.equal(data.state.cancelled.size, 0); assert.equal(data.state.closed, 1); safe(report)
  }
})
test('preflight does not request scope details for already settled Factory tasks', async () => {
  for (const historicalTask of [{ status: 'cancelled' }, { status: 'revoked' }, { status: 'completed' }, { status: 'succeeded' },
    { status: 'passed', stage: 'monitor' }, { status: 'passed', stage: 'approval', candidateId: id(904), candidateSha: null }]) {
    const data = fixture({ historicalTask }), report = await run(data)
    assert.equal(report.status, 'ready', JSON.stringify(report))
    assert.equal(data.calls.some(call => call.path === '/mikka/api/factory/tasks/' + id(901)), false)
    assert.equal(data.state.cancelled.size, 0); assert.equal(data.state.closed, 1); safe(report)
  }
})
test('foreign historical Factory tasks remain untouched while failed owned acceptance still cancels its task', async () => {
  const data = fixture({ historicalTask: {}, failure: 'review_failed' }), report = await run(data, true)
  assert.equal(data.submissions.length, 1, JSON.stringify(report))
  assert.equal(report.status, 'blocked'); assert.equal(data.state.cancelled.size, 1)
  assert.equal(data.state.cancelled.has(data.submissions[0].taskId), true)
  assert.equal(data.state.cancelled.has(id(901)), false)
  assert.equal(data.calls.filter(call => call.path === '/mikka/api/factory/tasks/' + id(901)).every(call => call.method === 'GET'), true)
  assert.equal(report.cases[0].cleanup.state, 'complete'); assert.equal(data.state.closed, 1); safe(report)
})

test('a default team switches only this login session to its verified personal workspace before reading Coordinator', async () => {
  const data = fixture({ teamDefault: true }), report = await run(data)
  assert.equal(report.status, 'ready', JSON.stringify(report))
  assert.equal(report.workspaceId, workspaceId); assert.equal(report.workspaceSelection, 'switched_personal')
  const reads = data.calls.filter(value => value.path === '/mikka/api/workspace')
  assert.deepEqual(reads.map(value => value.search), ['', '?workspace=' + workspaceId, ''])
  assert.match(reads[2].headers.cookie, /better-auth\.session_token=PRIVATE_COOKIE/)
  assert.ok(reads[2].headers.cookie.includes('mikka-workspace=' + workspaceId))
  assert.ok(data.calls.findIndex(value => value.path === '/mikka/api/coordinator/messages') > data.calls.indexOf(reads[2]))
  assert.deepEqual(data.calls.filter(value => value.method !== 'GET').map(value => value.body?.action ?? value.path),
    ['/mikka/api/auth/sign-in/email', 'workspace.switchWorkspace', '/mikka/api/auth/sign-out'])
  assert.equal(data.submissions.length, 0); assert.equal(data.profiles.size, 0); assert.equal(data.state.closed, 1); safe(report)
})
test('workspace selection rejects ambiguous choices, teams and another account personal membership before switching', async () => {
  const guards = [
    value => ({ ...value, choices: value.choices.filter(choice => choice.kind !== 'personal') }),
    value => ({ ...value, choices: [...value.choices, { id: id(4), kind: 'personal' }] }),
    value => ({ ...value, workspace: { ...value.workspace, kind: 'team' } }),
    value => ({ ...value, currentUserId: 'PRIVATE_OTHER_OWNER' }),
    value => ({ ...value, role: 'member' }),
    value => ({ ...value, members: [{ userId: 'PRIVATE_OTHER_OWNER', role: 'admin', status: 'active' }] }),
    value => ({ ...value, members: [{ ...value.members[0], role: 'member' }] }),
    value => ({ ...value, members: [{ ...value.members[0], status: 'inactive' }] }),
    value => ({ ...value, members: [...value.members, { userId: 'PRIVATE_OTHER_OWNER', role: 'member', status: 'inactive' }] }),
  ]
  for (const teamDefault of [false, true]) for (const workspaceView of guards) {
    const data = fixture({ teamDefault, workspaceView }), report = await run(data, true)
    assert.equal(report.code, 'workspace_missing', JSON.stringify(report))
    assert.equal(data.calls.some(value => value.path === '/mikka/api/rpc' || value.path === '/mikka/api/coordinator/messages'), false)
    assert.equal(data.submissions.length, 0); assert.equal(data.profiles.size, 0); assert.equal(data.state.closed, 1); safe(report)
  }
})
test('workspace switch acknowledgement and cookie readback failures stop before Coordinator and close the session', async () => {
  for (const failure of ['workspace_switch_mismatch', 'workspace_cookie_missing', 'workspace_readback_failed']) {
    const data = fixture({ teamDefault: true, failure }), report = await run(data, true)
    assert.equal(report.code, failure === 'workspace_readback_failed' ? 'http_refused' : 'workspace_missing', JSON.stringify(report))
    assert.equal(data.calls.filter(value => value.body?.action === 'workspace.switchWorkspace').length, 1)
    assert.equal(data.calls.some(value => value.path === '/mikka/api/coordinator/messages'), false)
    assert.equal(data.submissions.length, 0); assert.equal(data.profiles.size, 0); assert.equal(data.state.closed, 1); safe(report)
  }
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
    assert.equal(value.flowVersion, 2); assert.equal(value.runs.length, 2); assert.deepEqual(value.checks.map(check => check.stage), ['review'])
    assert.equal(value.acceptance.status, 'accepted'); assert.equal(value.task.stage, 'approval'); assert.equal(value.task.status, 'passed')
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
  assert.equal(data.state.accepted.size, 2); assert.equal(data.state.cancelled.size, 0)
  assert.equal(data.calls.filter(value => value.method === 'DELETE' && !value.path.includes('/agent-profiles/')).length, 0)
  safe(report)
})
test('successful terminal runs close only their own machines and retain task evidence', async () => {
  const baselineRuns = [id(900)], data = fixture({ baselineRuns }), report = await run(data, true)
  assert.equal(report.status, 'runtime_verified', JSON.stringify(report))
  const cleanup = report.cases[0].cleanup, own = data.submissions[0].runs
  assert.equal(cleanup.ownRunsStopped, true); assert.equal(cleanup.ownMachinesEnded, true)
  assert.deepEqual(cleanup.machines, own.map(runId => ({ runId, status: 'ended' })))
  assert.deepEqual(data.calls.filter(call => call.path.startsWith('/mikka/api/threads/')).map(call => call.path),
    own.map(runId => '/mikka/api/threads/' + runId + '/machine'))
  assert.equal(data.calls.some(call => call.path.includes(baselineRuns[0])), false)
  assert.equal(data.calls.some(call => call.path.endsWith('/stop')), false, 'successful native runs are already terminal')
  assert.equal(cleanup.evidence, 'retained'); assert.equal(data.state.cancelled.size, 0); safe(report)
})
test('a missing machine requires a fresh owned run and an explicit null machine read', async () => {
  const data = fixture({ machineFailure: 'missing' }), report = await run(data, true)
  assert.equal(report.status, 'runtime_verified', JSON.stringify(report))
  const runId = data.submissions[0].runs[0], endIndex = data.calls.findIndex(call => call.path === '/mikka/api/threads/' + runId + '/machine')
  assert.deepEqual(data.calls.slice(endIndex + 1, endIndex + 3).map(call => call.path),
    ['/mikka/api/runs/' + runId + '/evidence', '/mikka/api/mobile/threads/' + runId + '/machine'])
  assert.deepEqual(report.cases[0].cleanup.machines.map(value => value.status), ['not_created', 'ended'])
  assert.equal(report.cases[0].cleanup.ownMachinesEnded, true); safe(report)
})
test('machine failures never turn a completed task green and do not prevent closing another owned machine', async () => {
  for (const machineFailure of ['conflict', 'unavailable', 'timeout', 'invalid', 'wrong_id', 'wrong_state', 'wrong_status',
    'missing_scope', 'missing_ended', 'missing_invalid']) {
    const data = fixture({ machineFailure }), report = await run(data, true)
    const result = report.cases[0], cleanup = result.cleanup
    assert.equal(report.status, 'blocked', machineFailure); assert.equal(result.code, 'cleanup_incomplete', JSON.stringify(report))
    assert.equal(result.acceptanceStatus, 'runtime_verified'); assert.equal(cleanup.state, 'incomplete')
    assert.equal(cleanup.ownRunsStopped, true); assert.equal(cleanup.ownMachinesEnded, false)
    assert.deepEqual(cleanup.machines.map(value => value.status), ['failed', 'ended'])
    assert.equal(data.calls.filter(call => call.path.startsWith('/mikka/api/threads/')).length, 2)
    assert.equal(cleanup.profileArchived, true); assert.equal(cleanup.modelRestored, true)
    assert.equal(report.sessionClosed, true); safe(report)
  }
})
test('legacy Factory tasks still require review and verify before the normal deliverable acceptance', async () => {
  const data = fixture({ flowVersion: 1 }), report = await run(data, true)
  assert.equal(report.status, 'runtime_verified', JSON.stringify(report))
  assert.equal(report.cases[0].flowVersion, 1); assert.equal(report.cases[0].runs.length, 3)
  assert.deepEqual(report.cases[0].checks.map(value => value.stage), ['review', 'verify'])
  assert.equal(data.state.accepted.size, 1); assert.equal(data.state.cancelled.size, 0); safe(report)
})
test('missing, failed or stale Factory checks never reach approval, including legacy verify', async () => {
  for (const [flowVersion, failure] of [[2, 'execute_missing'], [2, 'review_missing'], [2, 'review_failed'], [2, 'review_stale'], [1, 'verify_missing']]) {
    const data = fixture({ flowVersion, failure }), report = await run(data, true)
    assert.equal(report.cases[0].code, 'task_checks_missing', JSON.stringify(report))
    assert.equal(data.calls.filter(value => value.path.endsWith('/approval')).length, 0)
    assert.equal(data.state.accepted.size, 0); assert.equal(data.state.cancelled.size, 1)
    assert.equal(report.cases[0].cleanup.state, 'complete'); safe(report)
  }
})
test('deliverable approval requires its receipt, never accepts a repository and never retries a lost response', async () => {
  for (const [failure, code, posts] of [['repository_candidate', 'task_scope', 0], ['approval_refused', 'http_refused', 1],
    ['acceptance_receipt_missing', 'task_acceptance', 1], ['lost_acceptance_response', 'request_failed', 1]]) {
    const data = fixture({ failure }), report = await run(data, true)
    assert.equal(report.status, 'blocked'); assert.equal(report.cases[0].code, code, JSON.stringify(report))
    assert.equal(data.calls.filter(value => value.path.endsWith('/approval')).length, posts)
    assert.equal(report.cases[0].cleanup.state, 'complete', JSON.stringify(report))
    assert.equal(data.state.cancelled.size, data.state.accepted.size ? 0 : 1)
    assert.equal(data.submissions.length, 1); safe(report)
  }
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
test('prepare is explicit, requires execution and restores only its acknowledged settings', async () => {
  const invalid = fixture({ profileBusy: true, paidFallback: true })
  await assert.rejects(run(invalid, false, {}, { prepare: true }), /configuration_required/)
  assert.equal(invalid.calls.length, 0)
  const data = fixture({ profileBusy: true, paidFallback: true }), report = await run(data, true, {}, { prepare: true })
  assert.equal(report.status, 'runtime_verified', JSON.stringify(report))
  assert.deepEqual(report.preparation, { requested: true, profilesDisabled: 1, profilesRestored: 1, fallbackChanged: true,
    restoration: 'complete', visibleRunRowsChecked: 0, restoreFailures: 0, fallbackRestored: true })
  assert.deepEqual(data.profiles.get(existingProfile.id), { ...existingProfile, version: 5, digest: '5'.repeat(64) })
  assert.equal(data.state.fallback, true)
  assert.deepEqual(data.calls.filter(value => value.body?.action === 'model-api-keys.updateApiKeyAfterQuota').map(value => decode(value.body.args)),
    [[false, workspaceId], [true, workspaceId]])
  assert.equal(data.submissions.length, 1); safe(report)
})
test('prepare refuses owner-wide activity and inherited model choices without changing settings', async () => {
  for (const [failure, code] of [['owner_busy', 'owner_busy'], ['unchosen', 'model_not_restorable']]) {
    const data = fixture({ failure, profileBusy: true, paidFallback: true }), report = await run(data, true, {}, { prepare: true })
    assert.equal(report.code, code, JSON.stringify(report))
    assert.equal(report.preparation.restoration, 'not_needed')
    assert.equal(data.submissions.length, 0); assert.equal(data.state.fallback, true)
    assert.deepEqual(data.profiles.get(existingProfile.id), existingProfile)
    assert.equal(data.calls.filter(value => value.method === 'PATCH' || value.body?.action === 'model-api-keys.updateApiKeyAfterQuota').length, 0)
    safe(report)
  }
})
test('a blocked case does not prevent preparation and execution of another available model', async () => {
  const data = fixture({ failure: 'claude_blocked', profileBusy: true, paidFallback: true })
  const report = await run(data, true, { MIKKA_OBSERVABILITY_MODEL_CASE: 'all' }, { prepare: true })
  assert.equal(report.status, 'blocked')
  assert.equal(report.cases[0].code, 'source_blocked')
  assert.equal(report.cases[1].status, 'runtime_verified', JSON.stringify(report))
  assert.equal(data.submissions.length, 1); assert.equal(data.submissions[0].item.id, 'codex')
  assert.equal(report.preparation.restoration, 'complete'); assert.equal(data.state.fallback, true); safe(report)
})
test('preparation failures restore acknowledged writes but never guess after a lost response', async () => {
  for (const failure of ['prepare_profile_refused', 'prepare_profile_lost', 'prepare_fallback_lost']) {
    const data = fixture({ failure, profileBusy: true, paidFallback: true }), report = await run(data, true, {}, { prepare: true })
    assert.equal(report.status, 'blocked'); assert.equal(data.submissions.length, 0)
    if (failure === 'prepare_profile_refused') {
      assert.equal(report.code, 'http_refused'); assert.equal(report.preparation.restoration, 'complete')
      assert.deepEqual(data.profiles.get(existingProfile.id), existingProfile); assert.equal(data.state.fallback, true)
    } else {
      assert.equal(report.code, 'preparation_restore_failed')
      assert.equal(report.preparation.restoreError.code, 'preparation_conflict')
      assert.equal(data.profiles.get(existingProfile.id).enabled, failure === 'prepare_fallback_lost')
      assert.equal(data.state.fallback, failure !== 'prepare_fallback_lost')
    }
    assert.equal(data.state.closed, 1); safe(report)
  }
})
test('restoration failures and concurrent edits remain visible without overwriting them', async () => {
  for (const failure of ['restore_profile_refused', 'restore_fallback_refused', 'concurrent_profile', 'owner_busy_restore']) {
    const data = fixture({ failure, profileBusy: true, paidFallback: true }), report = await run(data, true, {}, { prepare: true })
    assert.equal(report.code, 'preparation_restore_failed', JSON.stringify(report))
    assert.equal(report.preparation.restoration, 'incomplete')
    assert.equal(data.submissions.length, 1); assert.equal(data.state.closed, 1)
    if (failure === 'concurrent_profile') {
      assert.equal(report.preparation.restoreError.code, 'preparation_conflict')
      assert.equal(data.profiles.get(existingProfile.id).instructions, 'PRIVATE_CONCURRENT_EDIT')
      assert.equal(data.calls.filter(value => value.method === 'PATCH').length, 1)
    } else if (failure === 'owner_busy_restore') {
      assert.equal(report.preparation.restoreError.code, 'owner_busy')
      assert.equal(data.state.fallback, false); assert.equal(data.profiles.get(existingProfile.id).enabled, false)
    }
    safe(report)
  }
  const data = fixture({ failure: 'concurrent_fallback', paidFallback: true }), report = await run(data, true, {}, { prepare: true })
  assert.equal(report.cases[0].code, 'paid_fallback_enabled')
  assert.equal(report.preparation.restoration, 'complete'); assert.equal(data.state.fallback, true)
  assert.equal(data.calls.filter(value => value.body?.action === 'model-api-keys.updateApiKeyAfterQuota').length, 1)
  safe(report)
})
test('issue inventory follows real opaque cursors beyond 100 rows and rejects a moving scan', async () => {
  const rows = Array.from({ length: 135 }, (_, index) => ({ id: id(1000 + index), revision: 1, updatedAt: '2026-11-06T00:00:00.000Z' }))
  const cursors = ['opaque-50_/+', 'opaque-100_/+'], calls = []
  const read = async path => {
    const url = new URL(path, ORIGIN), cursor = url.searchParams.get('cursor')
    assert.equal(url.pathname, '/api/issues/search'); assert.equal(url.searchParams.get('workspaceId'), workspaceId)
    assert.equal(url.searchParams.get('limit'), '50'); assert.equal(url.searchParams.get('q'), '')
    assert.ok(cursor === null || cursors.includes(cursor)); calls.push(cursor)
    const page = cursor === null ? 0 : cursors.indexOf(cursor) + 1
    return { items: rows.slice(page * 50, (page + 1) * 50), truncated: false, nextCursor: cursors[page] ?? null }
  }
  assert.deepEqual(await issueInventory(read, workspaceId), rows.map(({ id }) => ({ id })))
  assert.deepEqual(calls, [null, ...cursors, null])
  let heads = 0
  await assert.rejects(issueInventory(async path => {
    const result = await read(path)
    if (!new URL(path, ORIGIN).searchParams.has('cursor') && ++heads === 2) result.items = [{ ...rows[0], revision: 2 }, ...result.items.slice(1)]
    return result
  }, workspaceId), /task_inventory_changed/)
  await assert.rejects(issueInventory(async () => ({ items: rows.slice(0, 50), nextCursor: cursors[0], truncated: false }), workspaceId), /task_inventory_changed/)
})
test('browser submission requires one executed case and does not authenticate on invalid options', async () => {
  const data = fixture()
  await assert.rejects(run(data, false, {}, { browserSubmit: true }), /configuration_required/)
  await assert.rejects(run(data, true, { MIKKA_OBSERVABILITY_MODEL_CASE: 'all' }, { browserSubmit: true }), /configuration_required/)
  assert.equal(data.calls.length, 0)
})
test('browser mode publishes readiness then observes the real-shaped UI click through push without an API submission', async () => {
  for (const locale of ['en', 'zh-CN']) {
    const data = fixture({ profileBusy: true, paidFallback: true })
    let ready, liveRevision = 0, waits = 0
    const report = await run(data, true, {}, { prepare: true, browserSubmit: true,
      onBrowserReady: value => {
        ready = value
        assert.equal(data.submissions.length, 0); assert.equal(data.state.fallback, false)
        assert.equal(data.profiles.get(value.profileId).enabled, true)
        assert.equal(data.state.current.modelId, value.model)
      },
      openLiveImpl: async () => ({ get revision() { return liveRevision }, close() {}, wait: async after => {
        assert.equal(after, liveRevision); assert.equal(waits++, 0); assert.ok(ready)
        data.supplySubmission(ready.profileId, browserSubmissionText(ready.input, locale)); liveRevision++
      } }),
    })
    assert.equal(report.status, 'runtime_verified', JSON.stringify(report))
    assert.equal(ready.type, 'mikka_observability_browser_ready')
    assert.equal(ready.input, fixtureTask(revision, CASES[0]).input)
    assert.equal(ready.botId, botId); assert.equal(ready.workspaceId, workspaceId); assert.equal(ready.destination, 'cloud')
    assert.equal(ready.artifact.content, fixtureTask(revision, CASES[0]).content)
    assert.ok(Date.parse(ready.expiresAt) > Date.parse(report.startedAt))
    assert.equal(waits, 1); assert.equal(data.submissions.length, 1)
    assert.equal(report.submissionSource, 'browser')
    assert.deepEqual(report.cases[0].submission, { source: 'browser', observed: true, position: 11, locale })
    assert.equal(report.cases[0].requestTrace, undefined)
    assert.equal(report.browserReplayVerified, false); assert.equal(report.posthogIngestionVerified, false)
    assert.equal(data.calls.filter(value => value.body?.action === 'coordinator.sendCoordinatorMessage').length, 0)
    assert.ok(data.calls.every(value => !value.headers.traceparent && !value.headers['x-posthog-session-id']))
    assert.equal(report.preparation.restoration, 'complete'); assert.equal(report.cases[0].cleanup.state, 'complete')
    safe(ready); safe(report)
  }
})
test('browser waiting times out or blocks changed UI text without sending or repeating a task', async () => {
  for (const foreign of [false, true]) {
    const data = fixture(), report = await run(data, true, {}, { browserSubmit: true, onBrowserReady: value => {
      if (foreign) data.foreignMessages.push({ position: 11, from: 'person', text: browserSubmissionText(value.input, 'en') + ' altered ' + value.marker })
    } })
    assert.equal(report.status, 'blocked')
    assert.equal(report.cases[0].code, foreign ? 'foreign_activity' : 'task_timeout', JSON.stringify(report))
    assert.equal(report.cases[0].cleanup.state, 'complete')
    assert.equal(data.submissions.length, 0); assert.equal(data.state.closed, 1)
    assert.equal(data.calls.filter(value => value.body?.action === 'coordinator.sendCoordinatorMessage').length, 0)
    safe(report)
  }
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

test('implicit default preflight requires server absence evidence and never writes a preference', async () => {
  const data = fixture({ implicitDefault: true }), report = await run(data)
  assert.equal(report.status, 'ready', JSON.stringify(report))
  assert.equal(data.state.storedPreference, false)
  assert.equal(data.calls.some(call => call.path === '/mikka/api/mobile/model' && call.method !== 'GET'), false)
  assert.ok(data.calls.some(call => call.path === '/mikka/api/mobile/model' && call.search.includes('choiceState=1')))
  const inherited = inventory(); inherited.menu.current = { ...original, chosen: false }
  assert.throws(() => preflightCase(CASES[0], inherited), { code: 'model_not_restorable' })
  safe(report)
})

test('implicit default restores absence with the stored binding and revision, not the catalogue option', async () => {
  const data = fixture({ implicitDefault: true }), report = await run(data, true)
  assert.equal(report.status, 'runtime_verified', JSON.stringify(report))
  assert.equal(data.state.storedPreference, false); assert.equal(data.state.current.chosen, false)
  const writes = data.calls.filter(call => call.path === '/mikka/api/mobile/model' && call.method === 'PUT')
  assert.deepEqual(writes.map(call => call.body), [
    { bot: botId, id: options[0].id, mode: 'temporary-if-absent' },
    { bot: botId, mode: 'restore-implicit', bindingId: id(991), revision: '12345' },
  ])
  assert.equal(report.cases[0].cleanup.modelRestored, true); safe(report)
})

test('implicit default never overwrites a preference created after preflight', async () => {
  const data = fixture({ implicitDefault: true, failure: 'temporary_preflight_race' }), report = await run(data, true)
  assert.equal(report.status, 'blocked'); assert.equal(data.submissions.length, 0)
  assert.equal(data.state.storedPreference, true)
  assert.equal(data.calls.some(call => call.body?.mode === 'restore-implicit'), false)
  safe(report)
})

test('implicit default stops after a lost or incomplete first selection receipt without guessing ownership', async () => {
  for (const failure of ['temporary_select_lost', 'temporary_receipt_missing']) {
    const data = fixture({ implicitDefault: true, failure }), report = await run(data, true)
    assert.equal(report.status, 'blocked'); assert.equal(report.cases[0].code, 'cleanup_incomplete')
    assert.equal(data.submissions.length, 0); assert.equal(data.state.storedPreference, true)
    assert.equal(data.calls.filter(call => call.body?.mode === 'temporary-if-absent').length, 1)
    assert.equal(data.calls.some(call => call.body?.mode === 'restore-implicit'), false)
    assert.equal(report.cases[0].cleanup.modelRestored, false); safe(report)
  }
})

test('implicit default preserves a same-value concurrent rewrite when the revision no longer matches', async () => {
  const data = fixture({ implicitDefault: true, failure: 'temporary_same_value_edit' }), report = await run(data, true)
  assert.equal(report.status, 'blocked'); assert.equal(report.cases[0].code, 'cleanup_incomplete')
  assert.equal(data.state.storedPreference, true); assert.equal(report.cases[0].cleanup.modelRestored, false)
  assert.equal(data.calls.filter(call => call.body?.mode === 'restore-implicit').length, 1); safe(report)
})

test('implicit default checks absence once after a lost restoration response and does not repeat deletion', async () => {
  const data = fixture({ implicitDefault: true, failure: 'temporary_restore_lost' }), report = await run(data, true)
  assert.equal(report.status, 'runtime_verified', JSON.stringify(report))
  const restore = data.calls.findIndex(call => call.body?.mode === 'restore-implicit')
  assert.ok(restore >= 0)
  assert.equal(data.calls.filter(call => call.body?.mode === 'restore-implicit').length, 1)
  assert.equal(data.calls.slice(restore + 1).filter(call => call.path === '/mikka/api/mobile/model' && call.method === 'GET').length, 1)
  assert.equal(data.state.storedPreference, false); assert.equal(report.cases[0].cleanup.modelRestored, true)
  safe(report)
})
