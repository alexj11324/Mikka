import assert from 'node:assert/strict'
import test from 'node:test'
import { FILES, TARGET, guard, projectDetail, requestAllowed, runDiagnostic, sourceHelpers } from './codex-runtime-evidence-diagnostic.mjs'

const revision = 'a'.repeat(40), ref = 'refs/heads/' + TARGET.branch
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: TARGET.repository, GITHUB_REPOSITORY_OWNER: TARGET.actor,
  GITHUB_ACTOR: TARGET.actor, GITHUB_ACTOR_ID: TARGET.actorId, GITHUB_TRIGGERING_ACTOR: TARGET.actor,
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref, GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '1234', GITHUB_SHA: revision,
  GITHUB_WORKFLOW_REF: `${TARGET.repository}/${TARGET.workflow}@${ref}`, GH_TOKEN: 'synthetic-github-token',
  SMOKE_OWNER_EMAIL: 'synthetic+mikka-smoke@example.invalid', SMOKE_OWNER_PASSWORD: 'synthetic-password' }
const event = { repository: { full_name: TARGET.repository, owner: { login: TARGET.actor } },
  sender: { login: TARGET.actor, id: Number(TARGET.actorId) }, ref, after: revision, forced: false, deleted: false }
const checkout = { head: revision, parents: [TARGET.source], clean: true, files: FILES.map(path => ({ status: 'A', path })) }

test('only the fixed actor, first push attempt, real parent and exactly three added files pass', () => {
  assert.equal(guard(env, event, checkout).driverRunId, 1234)
  for (const patch of [{ GITHUB_ACTOR: 'other' }, { GITHUB_ACTOR_ID: '0' }, { GITHUB_TRIGGERING_ACTOR: 'other' },
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_SHA: 'main' }, { GITHUB_WORKFLOW_REF: 'other' }]) assert.throws(() => guard({ ...env, ...patch }, event, checkout))
  for (const patch of [{ forced: true }, { deleted: true }, { after: 'b'.repeat(40) }, { sender: { login: 'other', id: 1 } }]) assert.throws(() => guard(env, { ...event, ...patch }, checkout))
  for (const patch of [{ parents: ['b'.repeat(40)] }, { parents: [TARGET.source, TARGET.source] }, { clean: false },
    { files: checkout.files.slice(1) }, { files: [...checkout.files, { status: 'M', path: 'lib/auth.ts' }] },
    { files: checkout.files.map(row => ({ ...row, status: 'M' })) }]) assert.throws(() => guard(env, event, { ...checkout, ...patch }))
})

test('the request allowlist rejects other runs, writes, external targets and altered RPC arguments', () => {
  const base = TARGET.origin + '/mikka', issueId = '10000000-0000-4000-8000-000000000001'
  const context = { driverRunId: 1234, issueId }, body = { version: 1, action: 'agents.getIssueThread', args: [issueId, TARGET.runId] }
  assert.equal(requestAllowed(base + '/api/rpc', 'POST', body, context), true)
  for (const action of ['agents.stopRun', 'agents.removeDevice', 'agents.pollDevices', 'issues.saveIssue'])
    assert.equal(requestAllowed(base + '/api/rpc', 'POST', { ...body, action }, context), false)
  for (const args of [[issueId, issueId], [null, TARGET.runId], [issueId, TARGET.runId, null]])
    assert.equal(requestAllowed(base + '/api/rpc', 'POST', { ...body, args }, context), false)
  for (const path of ['/api/devices/enrollment', '/api/runs/other/evidence', '/api/rpc?next=other', '/api/auth/sign-in/email/'])
    assert.equal(requestAllowed(base + path, 'POST', body, context), false)
  assert.equal(requestAllowed('https://outside.example/api/version', 'GET', undefined, context), false)
  assert.equal(requestAllowed(base + '/api/auth/sign-in/email', 'POST', { email: 'owner@example.invalid', password: 'x', rememberMe: false }, context), false)
})

const helpers = await sourceHelpers()
const detail = () => ({ thread: { id: TARGET.runId, latestRunId: TARGET.runId, status: 'failed', ownedByCurrentUser: true,
  prompt: 'Read README and reply STARTUP_OK_1234abcd_1', error: 'subscription_local_runtime_unavailable (adapter_start_failed)',
  attempts: [{ runId: TARGET.runId, status: 'failed', stopping: false }], modelFallback: [] },
  chunks: [{ at: new Date(), chunk: { type: 'data-run-stage', data: { stage: 'agent_start', ms: 15, ok: false } } }], messages: [] })

test('closed projection retains the actual failed stage and drops private values and unknown errors', () => {
  const value = detail(), secret = 'private-provider-response-and-token'
  value.thread.ownerName = secret; value.messages.push({ text: secret }); value.thread.modelFallback.push({ state: secret, failure: secret })
  value.chunks.push({ chunk: { type: 'error', errorText: secret } })
  const report = projectDetail(value, helpers)
  assert.deepEqual(report.error, { code: 'subscription_local_runtime_unavailable', detail: 'adapter_start_failed' })
  assert.deepEqual(report.stages, [{ stage: 'agent_start', ok: false, ms: 15 }])
  assert.equal(report.executionProofSatisfied, false)
  assert.equal(JSON.stringify(report).includes(secret), false)
  assert.deepEqual(report.streamErrors, [{ code: 'unclassified', detail: null }])
  value.thread.error = 'Model provider failed (auth: authentication_failed; HTTP 401)'
  assert.deepEqual(projectDetail(value, helpers).error, { code: 'provider_failure', kind: 'auth', providerCode: 'authentication_failed', httpStatus: 401 })
  value.thread.error = 'unknown provider response mentioning quota ' + secret
  value.thread.attempts[0].status = 'paused'
  assert.deepEqual(projectDetail(value, helpers).error, { code: 'unclassified', detail: null })
  assert.equal(projectDetail(value, helpers).threadHasActiveAttempts, true)
})

test('a complete execution retains the production runtime evidence reason without exposing the receipt', () => {
  const value = detail(), epoch = Date.UTC(2026, 10, 7), secret = 'private-runtime-receipt-content'
  value.thread.status = 'succeeded'; value.thread.error = null
  value.thread.attempts[0].status = 'succeeded'
  const receipt = { version: 1, source: 'http_server_link', window: 'run_launch_to_agent_exit',
    scope: 'daemon_http_server_link_and_task_fetch', allFirstPartyHttpComplete: false,
    runIdHash: TARGET.runHash, harness: 'codex', startedAt: epoch, endedAt: epoch + 1000, ms: 1000,
    executionStartMs: 100, executionEndMs: 900, complete: true, truncated: false,
    agentAccepted: { kind: 'codex_turn_start_ack', at: epoch + 100, ms: 100 }, requests: [], counts: [],
    providerOutputChunks: 1, toolCallsStarted: 1, toolCallsCompleted: 1, toolCallsFailed: 0, private: secret }
  value.chunks = [
    { chunk: { type: 'data-run-stage', data: { stage: 'agent_start', ok: true, ms: 100 } } },
    { chunk: { type: 'tool-input-start', toolCallId: 'synthetic-tool' } },
    { chunk: { type: 'tool-output-available', toolCallId: 'synthetic-tool', output: secret } },
    { chunk: { type: 'text-delta', delta: 'STARTUP_OK_1234abcd_1' } },
    { chunk: { type: 'finish', messageMetadata: { mikkaRuntimeTiming: receipt } } },
  ]
  const report = projectDetail(value, helpers)
  assert.equal(report.executionProofSatisfied, true)
  assert.deepEqual(report.runtime, { status: 'complete', complete: true, truncated: false,
    officialAcknowledgement: true, evidence: 'unavailable', reason: 'official_provider_timings_missing' })
  assert.equal(JSON.stringify(report).includes(secret), false)
  receipt.runIdHash = '0'.repeat(16)
  assert.equal(projectDetail(value, helpers).runtime.status, 'invalid')
  assert.equal(projectDetail(value, helpers).runtime.reason, null)
})

test('normal login reads only the fixed case, uses the real RPC marker and signs out without mutating resources', async () => {
  const seen = [], issueId = '10000000-0000-4000-8000-000000000001', ownerId = 'synthetic-owner'
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname, body = init.body && JSON.parse(init.body)
    seen.push({ path, method: init.method, action: body?.action })
    if (url.startsWith('https://api.github.com/')) return Response.json({ id: 1234, run_attempt: 1, head_sha: revision,
      path: TARGET.workflow, head_branch: TARGET.branch, event: 'push', repository: { full_name: TARGET.repository },
      head_repository: { full_name: TARGET.repository }, actor: { login: TARGET.actor, id: Number(TARGET.actorId) },
      triggering_actor: { login: TARGET.actor }, status: 'in_progress', conclusion: null })
    if (path.endsWith('/api/version')) return Response.json({ build: TARGET.source })
    if (path.endsWith('/sign-in/email')) return Response.json({ user: { id: ownerId } }, { headers: { 'set-cookie': 'session=synthetic-session; Secure; HttpOnly' } })
    assert.equal(init.headers.cookie, 'session=synthetic-session')
    if (path.endsWith('/get-session')) return Response.json({ user: { id: ownerId, email: env.SMOKE_OWNER_EMAIL, emailVerified: true } })
    if (path.endsWith('/evidence')) return Response.json({ run: { id: TARGET.runId, issueId, status: 'failed', harness: 'codex', model: 'gpt-6-luna',
      credentialType: 'subscription', executionIdentity: { requester: ownerId } } })
    if (path.endsWith('/api/rpc')) {
      assert.equal(init.headers['x-mikka-rpc'], '1')
      assert.deepEqual(body, { version: 1, action: 'agents.getIssueThread', args: [issueId, TARGET.runId] })
      return Response.json({ version: 1, ok: true, result: detail() })
    }
    assert.equal(path, '/mikka/api/auth/sign-out'); return Response.json({ success: true })
  }
  const report = await runDiagnostic({ env, identity: guard(env, event, checkout), helpers, fetchImpl })
  assert.equal(report.status, 'read'); assert.equal(report.originalGate, 'failed')
  assert.equal(report.modelCalls, 0); assert.equal(report.resourceMutations, 0); assert.equal(report.cleanup.sessionClosed, true)
  assert.deepEqual(seen.filter(row => row.method === 'POST').map(row => row.action ?? row.path),
    ['/mikka/api/auth/sign-in/email', 'agents.getIssueThread', '/mikka/api/auth/sign-out'])
  for (const secret of [env.GH_TOKEN, env.SMOKE_OWNER_EMAIL, env.SMOKE_OWNER_PASSWORD, ownerId, 'synthetic-session']) assert.equal(JSON.stringify(report).includes(secret), false)

  seen.length = 0
  const failed = await runDiagnostic({ env, identity: guard(env, event, checkout), helpers,
    fetchImpl: (url, init) => new URL(url).pathname.endsWith('/api/rpc') ? Response.json({ error: 'private-server-message' }, { status: 404 }) : fetchImpl(url, init) })
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure.stage, 'thread'); assert.equal(failed.failure.httpStatus, 404)
  assert.equal(failed.cleanup.sessionClosed, true)
  assert.equal(seen.at(-1).path, '/mikka/api/auth/sign-out')
  assert.equal(JSON.stringify(failed).includes('private-server-message'), false)
})
