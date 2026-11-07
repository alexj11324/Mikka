import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { diagnose, projectThread, safeError, TARGET } from './issue1512-candidate-diagnostic.mjs'

// This override is test-only. The executable always imports ./source at the fixed commit.
const source = resolve(process.env.MIKKA_DIAGNOSTIC_TEST_SOURCE ?? 'source')
const sourceApi = await import(pathToFileURL(join(source, 'scripts/acceptance/cloud-startup.mjs')).href)
const evidenceApi = await import(pathToFileURL(join(source, 'scripts/acceptance/cloud-startup-evidence.mjs')).href)
const account = readFileSync(join(source, 'scripts/e2b/validate-template-subscriptions.mjs'), 'utf8')
  .match(/env\.ACME_DEMO_EMAIL\?\.toLowerCase\(\) === '([^']+)'/)[1]
const OWNER = '10000000-0000-4000-8000-000000000001', ISSUE = '10000000-0000-4000-8000-000000000002'
const OTHER_DEVICE = '10000000-0000-4000-8000-000000000003', BINDING = '10000000-0000-4000-8000-000000000004'
const CANARY = 'CANARY_PRIVATE_DATA_MUST_NOT_LEAVE_RAM'
const env = { ACME_DEMO_EMAIL: account, ACME_DEMO_PASSWORD: CANARY }
const item = chunk => ({ chunk, at: '2026-11-07T04:26:41.000Z' })
const runtime = () => ({ version: 1, source: 'http_server_link', window: 'run_launch_to_agent_exit',
  scope: 'daemon_http_server_link_and_task_fetch', allFirstPartyHttpComplete: false,
  runIdHash: TARGET.runIdHash, harness: 'codex', startedAt: 1000, endedAt: 1100, ms: 100,
  executionStartMs: 10, executionEndMs: 95, complete: true, truncated: false,
  providerOutputChunks: 1, toolCallsStarted: 1, toolCallsCompleted: 1, toolCallsFailed: 0,
  requests: [], counts: [], agentAccepted: { kind: 'codex_turn_start_ack', at: 1020, ms: 20 } })
const fullThread = () => ({ thread: { id: TARGET.runId, rootRunId: TARGET.runId, latestRunId: TARGET.runId,
  status: 'succeeded', prompt: `Read one line, then reply STARTUP_OK_1234abcd_1. ${CANARY}`, error: null,
  attempts: [{ runId: TARGET.runId, status: 'succeeded', stopping: false }] }, chunks: [
  item({ type: 'data-run-stage', data: { stage: 'agent_start', ok: true, ms: 20 } }),
  item({ type: 'tool-input-available', toolCallId: 'private-tool-id', input: CANARY }),
  item({ type: 'tool-output-available', toolCallId: 'private-tool-id', output: CANARY }),
  item({ type: 'text-delta', delta: 'STARTUP_OK_1234' }), item({ type: 'text-delta', delta: `abcd_1 ${CANARY}` }),
  item({ type: 'finish', messageMetadata: { mikkaRuntimeTiming: runtime(), private: CANARY } }),
] })
const failedThread = () => ({ thread: { id: TARGET.runId, rootRunId: TARGET.runId, latestRunId: TARGET.runId,
  status: 'failed', prompt: CANARY, error: 'Codex subscription authentication unavailable',
  attempts: [{ runId: TARGET.runId, status: 'failed' }] }, chunks: [
  item({ type: 'data-run-stage', data: { stage: 'agent_start', ok: false, ms: 20 } }),
  item({ type: 'error', errorText: CANARY }), item({ type: CANARY, arbitrary: CANARY }),
] })
const evidence = () => ({ run: { id: TARGET.runId, issueId: ISSUE, harness: 'codex', model: 'gpt-6-luna',
  status: 'failed', credentialType: 'subscription', subscriptionRoute: 'codex_cli', private: CANARY,
  executionIdentity: { version: 1, requester: OWNER, executionPrincipal: OWNER, outputOwner: OWNER, workspaceId: TARGET.workspaceId,
    resourceBindings: [{ kind: 'device', id: TARGET.deviceId, ownerId: OWNER, access: 'owner' },
      { kind: 'subscription', id: BINDING, ownerId: OWNER, access: 'owner', revision: '2', private: CANARY }],
    billingAccount: { model: { kind: 'subscription', resourceId: BINDING, amount: 'provider_unknown', private: CANARY },
      runtime: { kind: 'local_device', resourceId: TARGET.deviceId, amount: 'not_applicable' } } } }, captures: [{ private: CANARY }] })

function fixture({ modify, clock } = {}) {
  const calls = [], clientState = { cleared: 0 }
  const api = { ...sourceApi, createSessionClient(origin, fetcher) {
    const client = sourceApi.createSessionClient(origin, fetcher), clear = client.clear
    client.clear = () => { clientState.cleared++; clear() }
    return client
  } }
  const fetchImpl = async (url, options) => {
    const u = new URL(url), payload = options.body ? JSON.parse(options.body) : null
    calls.push({ path: u.pathname + u.search, method: options.method ?? 'GET', action: payload?.action, args: payload?.args })
    assert.equal(options.redirect, 'error'); assert.equal(options.signal.aborted, false)
    let value, status = 200, headers = {}
    if (u.pathname === '/mikka/api/version') value = { build: TARGET.source }
    else if (u.pathname === '/mikka/api/auth/sign-in/email') { assert.equal(payload.password, CANARY); value = { private: CANARY }; headers = { 'set-cookie': `session=${CANARY}; Path=/; HttpOnly` } }
    else if (u.pathname === '/mikka/api/auth/get-session') { assert.match(options.headers.cookie, /session=/); value = { user: { id: OWNER, email: account, private: CANARY } } }
    else if (u.pathname === '/mikka/api/auth/sign-out') { value = { success: true }; headers = { 'set-cookie': 'session=; Max-Age=0' } }
    else if (u.pathname === `/mikka/api/runs/${TARGET.runId}/evidence`) value = evidence()
    else if (u.pathname === '/mikka/api/rpc') {
      let result
      if (payload.action === 'workspace.switchWorkspace') result = { ok: true, data: { workspaceId: TARGET.workspaceId } }
      else if (payload.action === 'agents.getIssueThread') result = failedThread()
      else if (payload.action === 'agents.listDevices') result = [{ id: OTHER_DEVICE, name: CANARY, repos: [{ private: CANARY }] },
        { id: TARGET.deviceId, name: CANARY, enabled: true, online: false, harnesses: [{ harness: 'codex', models: [CANARY] }],
          lastSeenAt: { $mikka: 'date', value: '2026-11-07T04:26:41.000Z' } }]
      else assert.fail('unexpected RPC')
      value = { version: 1, ok: true, result }
    } else if (u.pathname === '/mikka/api/factory/tasks') {
      assert.equal(u.search, `?issueId=${ISSUE}`)
      value = { issueId: ISSUE, tasks: [{ id: BINDING, issueId: ISSUE, status: 'failed', revision: 2, private: CANARY }] }
    } else assert.fail('unexpected endpoint')
    const changed = modify?.({ path: u.pathname, payload, value, calls })
    if (changed?.error) throw Error(changed.error)
    if (changed?.value) value = changed.value
    if (changed?.status) status = changed.status
    if (changed?.raw) return new Response(changed.raw, { status, headers })
    return Response.json(value, { status, headers })
  }
  return { calls, clientState, run: () => diagnose({ sourceApi: api, evidenceApi, env, fetchImpl, ...(clock ? { now: clock } : {}) }) }
}

test('the known-marker predicate agrees with the real fixed-source observer; content stays absent', () => {
  for (const change of [() => {}, value => { value.chunks.splice(2, 1) }, value => { value.chunks[0].chunk.data.ok = false },
    value => { value.chunks.at(-1).chunk.messageMetadata.mikkaRuntimeTiming.complete = false }]) {
    const detail = fullThread(); change(detail)
    const record = { runId: TARGET.runId, runIdHash: TARGET.runIdHash, harness: 'codex', sampleId: '1234abcd_1',
      requireReply: true, minToolCalls: 1, requireReplyAfterTool: true, requireRuntimeReceipt: true, requireTerminal: true, requireOfficialTiming: true }
    const actual = sourceApi.observeChunks(record, detail, Date.now()), projected = projectThread(detail, evidenceApi)
    assert.equal(projected.proof.complete, actual)
    assert.equal(projected.proof.replyMarker, record.replyVerified === true)
    assert.equal(projected.proof.replyAfterTool, record.replyVerifiedAfterTool === true)
    for (const privateText of [CANARY, 'private-tool-id', 'STARTUP_OK_1234abcd_1']) assert.ok(!JSON.stringify(projected).includes(privateText))
  }
})

test('missing or ambiguous prompt markers remain unknown, and pre-start text is not execution proof', () => {
  for (const prompt of [CANARY, 'STARTUP_OK_1234abcd_1 STARTUP_OK_abcd1234_1']) {
    const detail = fullThread(); detail.thread.prompt = prompt
    const value = projectThread(detail, evidenceApi)
    assert.equal(value.proof.replyMarker, null); assert.equal(value.proof.replyAfterTool, null)
    assert.deepEqual(value.proof.unknown, ['replyMarker', 'replyAfterTool']); assert.equal(value.proof.complete, false)
  }
  const detail = failedThread(); detail.chunks.unshift(item({ type: 'text-delta', delta: CANARY }))
  const value = projectThread(detail, evidenceApi)
  assert.equal(value.proof.providerOutput, false); assert.equal(value.error.classification, 'codex_subscription_auth_unavailable')
  assert.equal(value.chunkErrors[0].classification, 'unknown'); assert.match(value.chunkErrors[0].sha256, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(value).includes(CANARY)); assert.equal(safeError(`${CANARY} deviceHasActiveRuns`).classification, 'unknown')
})

test('normal owner reads use only the fixed scope, never emit contents, and sign out/clear once', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'complete'); assert.equal(report.cleanup.signOut, 'ok'); assert.equal(f.clientState.cleared, 1)
  assert.deepEqual(f.calls.map(row => row.action ?? row.path), ['/mikka/api/version', '/mikka/api/auth/sign-in/email', '/mikka/api/auth/get-session',
    'workspace.switchWorkspace', `/mikka/api/runs/${TARGET.runId}/evidence`, 'agents.getIssueThread', 'agents.listDevices',
    `/mikka/api/factory/tasks?issueId=${ISSUE}`, '/mikka/api/auth/sign-out'])
  assert.deepEqual(f.calls.find(row => row.action === 'agents.getIssueThread').args, [ISSUE, TARGET.runId])
  assert.equal(report.evidence.authority.deviceMatchesTarget, true); assert.equal(report.device.present, true)
  assert.deepEqual(report.device.harnesses, ['codex']); assert.equal(report.factory.tasks[0].status, 'failed')
  for (const secret of [CANARY, account, OTHER_DEVICE, 'private-tool-id', 'STARTUP_OK_', 'session=']) assert.ok(!JSON.stringify(report).includes(secret))
})

test('a deleted issue produces the closed refusal; no restore, retry, or broader run lookup occurs', async () => {
  const f = fixture({ modify: ({ payload, path }) => payload?.action === 'agents.getIssueThread'
    ? { value: { version: 1, ok: true, result: { error: 'issueNotFound' } } }
    : path === '/mikka/api/factory/tasks' ? { value: { error: 'issueNotFound' }, status: 404 } : null })
  const report = await f.run()
  assert.equal(report.status, 'partial')
  assert.equal(report.thread.error.classification, 'issueNotFound'); assert.equal(report.factory.error.classification, 'issueNotFound')
  assert.equal(report.cleanup.signOut, 'ok'); assert.equal(f.clientState.cleared, 1)
  assert.equal(f.calls.filter(row => row.action === 'agents.getIssueThread').length, 1)
  assert.equal(f.calls.filter(row => row.path.startsWith('/mikka/api/factory/')).length, 1)
})

test('wrong deployment or run cannot expand the read scope', async () => {
  for (const beforeLogin of [true, false]) {
    const f = fixture({ modify: ({ path, value }) => beforeLogin && path === '/mikka/api/version' ? { value: { build: '0'.repeat(40) } }
      : !beforeLogin && path.endsWith('/evidence') ? { value: { ...value, run: { ...value.run, id: OTHER_DEVICE } } } : null })
    const report = await f.run()
    assert.equal(report.status, 'blocked'); assert.equal(report.error.classification, beforeLogin ? 'build_mismatch' : 'run_mismatch')
    assert.equal(report.cleanup.signOut, beforeLogin ? 'not_started' : 'ok'); assert.equal(f.clientState.cleared, 1)
    assert.equal(f.calls.filter(row => ['agents.getIssueThread', 'agents.listDevices'].includes(row.action)).length, 0)
  }
})

test('unknown RPC and malformed JSON remain content-free, with no automatic retry', async () => {
  for (const malformed of [false, true]) {
    const f = fixture({ modify: ({ payload }) => payload?.action === 'agents.getIssueThread'
      ? malformed ? { raw: `{"private":"${CANARY}",INVALID}` } : { value: { version: 1, ok: true, result: { error: CANARY } } } : null })
    const report = await f.run()
    assert.equal(report.thread.status, 'unavailable'); assert.ok(!JSON.stringify(report).includes(CANARY))
    if (!malformed) assert.equal(report.requests.find(row => row.step === 'agents.getIssueThread').error.classification, 'unknown')
    assert.equal(f.calls.filter(row => row.action === 'agents.getIssueThread').length, 1); assert.equal(report.cleanup.signOut, 'ok')
  }
})

test('the 150-second read deadline reserves sign-out inside the 180-second total', async () => {
  let elapsed = 0
  const f = fixture({ clock: () => elapsed, modify: ({ path }) => { if (path.endsWith('/evidence')) elapsed = 150001 } })
  const report = await f.run()
  assert.equal(report.status, 'partial')
  assert.equal(report.cleanup.signOut, 'ok'); assert.equal(f.clientState.cleared, 1)
  assert.equal(f.calls.filter(row => ['agents.getIssueThread', 'agents.listDevices'].includes(row.action)).length, 0)
  assert.equal(f.calls.at(-1).path, '/mikka/api/auth/sign-out'); assert.equal(report.elapsedMs, 150001)
})

test('a failed sign-out is explicit and clears local cookies without retrying', async () => {
  const f = fixture({ modify: ({ path }) => path === '/mikka/api/auth/sign-out' ? { status: 503 } : null })
  const report = await f.run()
  assert.equal(report.status, 'blocked'); assert.equal(report.cleanup.signOut, 'failed'); assert.equal(f.clientState.cleared, 1)
  assert.equal(f.calls.filter(row => row.path === '/mikka/api/auth/sign-out').length, 1)
})

test('the executable refuses an unpinned/missing source before any session and writes a private receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-diagnostic-source-'))
  try {
    const output = join(dir, 'receipt.json'), helper = fileURLToPath(new URL('./issue1512-candidate-diagnostic.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [helper, output], { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(report.error.classification, 'source_invalid'); assert.equal(report.cleanup.signOut, 'not_started')
    assert.equal(statSync(output).mode & 0o777, 0o600); assert.ok(!`${result.stdout}${result.stderr}`.includes(dir))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
