import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'
import { alignServerTimings, createSessionClient, observeChunks, parseOptions, readProductionWorkerRelease, runCloudStartup, sampledRequestTrace } from './cloud-startup.mjs'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const workspace = id(1), botId = id(2), deviceId = id(3), agentId = id(4)
const epoch = Date.parse('2026-11-06T12:00:00.000Z')
const env = { ACME_DEMO_EMAIL: 'alex@acme.aspectlylabs.com', ACME_DEMO_PASSWORD: 'PRIVATE_PASSWORD' }
const models = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const options = (extra = []) => parseOptions(['--workspace', workspace, '--timeout-ms', '1000', ...extra], {})
const stage = (name, at, ok = true) => ({ at: new Date(epoch + at).toISOString(), chunk: { type: 'data-run-stage', data: { stage: name, ms: 300, ok } } })
const delta = (text, at = 4000) => ({ at: new Date(epoch + at).toISOString(), chunk: { type: 'text-delta', delta: text } })
const startupTiming = (runId, harness) => ({ version: 1, runIdHash: createHash('sha256').update(runId).digest('hex').slice(0, 16),
  harness, startedAt: epoch + 3000, endedAt: epoch + 3450, ms: 450, outcome: 'ok', truncated: false,
  phases: [{ name: 'daemon.adapter.cli_init', startMs: 50, endMs: 400, ms: 350, outcome: 'ok' }] })
const startedStage = sample => { const item = stage('agent_start', 3500); item.chunk.data.startupTiming = startupTiming(sample.runId, sample.harness); return item }

function fixture({ candidate = false, badEvidence = false, badBot = false, failDelete = false, stopRace = false } = {}) {
  const calls = [], samples = [], profiles = new Map(), sockets = []
  let current, clock = epoch, profileCount = 0
  const json = value => Response.json(value)
  const rpc = result => json({ version: 1, ok: true, result })
  const readDetail = sample => {
    sample.reads++
    return { thread: { id: sample.runId, status: sample.finished ? 'stopped' : sample.reads > 1 ? 'running' : 'preparing', createdAt: new Date(epoch).toISOString() },
      chunks: sample.reads > 1 ? [stage('repository', 1000), startedStage(sample),
        { at: new Date(epoch + 3700).toISOString(), chunk: { type: 'tool-input-start', toolCallId: 'safe-id' } },
        { at: new Date(epoch + 3800).toISOString(), chunk: { type: 'tool-output-available', toolCallId: 'safe-id', output: 'PRIVATE_README_CONTENT' } },
        delta('PRIVATE_PROVIDER_OUTPUT STARTUP_'), delta(`OK_${sample.marker}`, 4100)] : [stage('repository', 1000)],
      live: { runs: [{ id: sample.runId, workspaceId: workspace }] } }
  }
  const io = {
    calls, samples, sockets, now: () => clock += 10,
    WebSocketImpl: class {
      constructor(url, protocol) {
        assert.equal(url.searchParams.get('revisions'), '1')
        assert.equal(protocol, 'PRIVATE_LIVE_TICKET')
        this.readyState = 1; sockets.push(this)
        queueMicrotask(() => { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'live_ready', version: 2, kinds: ['run', 'thread'] }) }) })
      }
      close() { this.closed = true; this.readyState = 3 }
      send(message) { assert.equal(message, 'ping') }
    },
    fetchImpl: async (url, init) => {
      const path = url.pathname.replace('/mikka', '')
      calls.push({ path, init })
      if (path === '/api/version') return json({ build: 'BUILD1' })
      if (path === '/api/auth/sign-in/email') {
        assert.deepEqual(JSON.parse(init.body), { email: env.ACME_DEMO_EMAIL, password: env.ACME_DEMO_PASSWORD, rememberMe: false })
        return Response.json({}, { headers: { 'set-cookie': 'session=PRIVATE_COOKIE; Path=/; Secure; HttpOnly' } })
      }
      assert.match(init.headers.cookie ?? '', /session=PRIVATE_COOKIE/)
      if (path === '/api/auth/get-session') return json({ user: { id: 'PRIVATE_USER', email: env.ACME_DEMO_EMAIL } })
      if (path === '/api/auth/sign-out') return Response.json({}, { headers: { 'set-cookie': 'session=; Max-Age=0' } })
      if (path === `/api/bots/${botId}`) return json({ id: botId, name: badBot ? 'Other real work' : '测试1505 fixture' })
      if (path === '/api/rpc') {
        assert.equal(init.headers.origin, 'https://app.aspectlylabs.com')
        assert.equal(init.headers['x-mikka-rpc'], '1')
        const { action, args } = JSON.parse(init.body)
        if (action === 'workspace.switchWorkspace') return Response.json({ version: 1, ok: true, result: { ok: true, data: { workspaceId: args[0] } } },
          { headers: { 'set-cookie': `mikka-workspace=${args[0]}; Path=/` } })
        if (action === 'bots.createBot') return rpc({ id: botId, name: args[0].name })
        if (action === 'model-order.getModelOrder') return rpc({ candidates: Object.entries(models).map(([harness, model], index) => ({ harness, model, source: { kind: 'subscription', connectionId: id(50 + index) } })) })
        if (action === 'issues.saveIssue') {
          current = { issueId: id(100 + samples.length), runId: id(200 + samples.length), taskId: id(300 + samples.length),
            title: args[0].title, reads: 0, finished: false, workflowRunId: `wrun_TEST${samples.length}` }
          samples.push(current); return rpc({ issue: { id: current.issueId } })
        }
        if (action === 'coordinator.sendCoordinatorMessage') {
          const input = JSON.parse(args[0].match(/参数如下：(.*)。使用/)[1])
          assert.equal(input.repo, 'alexj11324/Mikka-handoff'); assert.equal(input.readOnly, true)
          assert.deepEqual(input.target, candidate ? { deviceId } : 'cloud')
          assert.equal(input.model, undefined)
          current.harness = profiles.get(input.profileId).harness; current.profileId = input.profileId
          current.marker = input.note.match(/STARTUP_OK_([A-Za-z0-9_-]+)/)[1]
          assert.match(init.headers.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/)
          return rpc({ queued: true })
        }
        if (action === 'coordinator.stopCoordinatorTurn') return rpc({ stopped: true })
        if (action === 'agents.pollIssueThreads') return rpc({ threads: [{ id: current.runId, ownedByCurrentUser: true }] })
        if (action === 'agents.getIssueThread') return rpc(readDetail(samples.find(sample => sample.runId === args[1])))
        if (action === 'agents.stopRun') {
          current.finished = true
          if (stopRace) return Response.json({ version: 1, ok: false, error: { code: 'runChainEnded' } }, { status: 409 })
          return rpc({ stoppedRunIds: [args[0]] })
        }
        if (action === 'issues.getIssue') return rpc({ issue: { id: current.issueId, title: current.title, revision: 2 } })
        if (action === 'issue-operations.setIssueDeleted') {
          assert.equal(args[0].id, current.issueId)
          if (failDelete) return Response.json({ error: 'PRIVATE_FAILURE' }, { status: 500 })
          current.deleted = true; return rpc({ deleted: true })
        }
        assert.fail(`unexpected RPC ${action}`)
      }
      if (path === '/api/factory/agent-profiles') {
        const body = JSON.parse(init.body), profile = { ...body.profile, id: id(500 + ++profileCount), version: 1 }
        assert.equal(profile.model.source.kind, 'subscription'); assert.equal(profile.model.model, models[profile.harness])
        profiles.set(profile.id, profile); return json({ profile })
      }
      if (path.startsWith('/api/factory/agent-profiles/')) { assert.equal(init.method, 'DELETE'); return json({ archived: true }) }
      if (path === '/api/coordinator/stream') {
        const output = JSON.stringify({ runId: current.runId, arbitraryLongField: 'truncated '.repeat(40), thread: 'new', placement: candidate ? { kind: 'device', deviceId } : { kind: 'cloud' } }).slice(0, 200)
        const events = [{ type: 'tool', name: 'dispatch_run', call: 'stale', state: 'running', input: JSON.stringify({issueId: id(999)}) },
          { type: 'tool', name: 'dispatch_run', call: 'stale', state: 'error', errorCode: 'staleDispatch' },
          { type: 'tool', name: 'dispatch_run', call: 'call_1', state: 'running', quote: `Read README then STARTUP_OK_${current.marker}`, at: 0 },
          { type: 'tool', name: 'dispatch_run', call: 'call_1', state: 'done', output }]
        return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n',
          { headers: { 'content-type': 'application/x-ndjson', 'x-mikka-stream-run': current.workflowRunId } })
      }
      if (/^\/api\/runs\/.*\/evidence$/.test(path)) return json({ run: { id: current.runId, issueId: current.issueId,
        harness: current.harness, model: models[current.harness], credentialType: badEvidence ? 'api_key' : 'subscription',
        subscriptionRoute: current.harness === 'codex' ? 'codex_cli' : 'claude_code_cli', agentProfile: { profileId: current.profileId },
        executionIdentity: { version: 1, requester: 'PRIVATE_USER', executionPrincipal: 'PRIVATE_USER',
          billingAccount: { model: { kind: 'subscription' }, runtime: { kind: candidate ? 'local_device' : 'e2b' } },
          resourceBindings: [{ kind: 'device', id: deviceId, access: 'owner' }, { kind: 'subscription', access: 'owner' }] } } })
      if (path === '/api/live/ticket') return json({ url: 'wss://live.example/v1/live/opaque/socket', protocol: 'PRIVATE_LIVE_TICKET', expiresAt: epoch + 300000 })
      if (path === '/api/factory/tasks') return json({ contractVersion: 1, issueId: current.issueId, tasks: [{ id: current.taskId, issueId: current.issueId }] })
      if (path === `/api/factory/tasks/${current.taskId}`) {
        if (init.method === 'POST') { current.cancelled = true; current.finished = !stopRace; return json({ cancelled: true }) }
        return json({ task: { id: current.taskId, issueId: current.issueId, status: 'running', revision: 1 }, attempts: [{ runId: current.runId }] })
      }
      if (/^\/api\/threads\/.*\/machine$/.test(path)) { assert.equal(candidate, false); current.machineEnded = true; return json({ ended: true }) }
      assert.fail(`unexpected endpoint ${path}`)
    },
  }
  return io
}

test('sampler IDs satisfy the installed 10% sampler, while invalid live configuration fails closed', () => {
  const sampler = new TraceIdRatioBasedSampler(0.1)
  for (let n = 0; n < 50; n++) {
    const { traceId, traceparent } = sampledRequestTrace()
    assert.match(traceId, /^0{16}[a-f0-9]{16}$/); assert.equal(sampler.shouldSample(undefined, traceId).decision, 2)
    assert.match(traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/)
  }
  for (const args of [['--runs', '2'], ['--origin', 'http://remote.example'], ['--mode', 'acceptance'],
    ['--device-id', deviceId, '--agent-id', agentId], ['--max-startup-ms', '0']]) assert.throws(() => options(args), /startup_/)
  assert.throws(() => createSessionClient('https://user:password@example.com'), /startup_origin_invalid/)
})

test('claim/running state and daemon stages do not prove provider execution; split marker only counts after agent_start', () => {
  const record = { sampleId: 'test', requireReply: true }
  assert.equal(observeChunks(record, { thread: { status: 'running' }, chunks: [delta('STARTUP_OK_test'), stage('repository', 10)] }, epoch), false)
  assert.equal(record.firstProviderChunk, undefined)
  assert.equal(observeChunks(record, { chunks: [stage('agent_start', 20, false), delta('STARTUP_OK_test')] }, epoch), false)
  assert.equal(record.agentStart, undefined)
  assert.equal(observeChunks(record, { chunks: [stage('agent_start', 20), delta('STARTUP_'), delta('OK_test')] }, epoch), true)
  assert.equal(record.replyVerified, true)
  assert.doesNotMatch(JSON.stringify(record), /STARTUP_OK_test/)
})

test('three real-shaped runs use normal cookies, pinned subscriptions, push reads and strictly owned cleanup', async () => {
  const io = fixture(), report = await runCloudStartup(options(), { env, ...io })
  assert.equal(report.status, 'awaiting_server_timings', JSON.stringify(report))
  assert.equal(report.samples.length, 3)
  assert.ok(report.samples.every(sample => sample.agentStart && sample.firstProviderChunk && sample.cleanup.status === 'passed'))
  assert.ok(report.samples.every(sample => sample.startupTimingStatus === 'complete' && sample.daemonStartupTiming.phases[0].ms === 350))
  assert.ok(report.samples.every(sample => sample.replyVerified && sample.toolCalls.length === 1 && sample.toolCalls[0].outcome === 'ok'))
  assert.ok(io.samples.every(sample => sample.cancelled && sample.deleted && sample.machineEnded && sample.reads === 3))
  assert.ok(io.sockets.every(socket => socket.closed))
  assert.ok(io.calls.every(call => call.init.redirect === 'error'))
  assert.equal(io.calls.filter(call => call.path === '/api/auth/sign-out').length, 1)
  assert.ok(io.calls.some(call => call.init.headers.cookie?.includes(`mikka-workspace=${workspace}`)))
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|alex@|cookie|ticket/i)
  const logs = report.samples.map(sample => ({ msg: 'dispatch_timing', workflowRunId: sample.workflowRunId, stepId: 'step',
    startedAt: epoch, endedAt: epoch + 2000, totalMs: 2000, failed: false, phases: [{ phase: 'resolveModel', ms: 20 }] }))
  const aligned = alignServerTimings(report, logs)
  assert.equal(aligned.status, 'baseline_recorded')
  assert.ok(aligned.samples.every(sample => sample.timing.dispatchToAgentStartMs === 3500 && sample.timing.dispatchToFirstProviderChunkMs === 3700))
})

test('startup intervals retain only closed fields and reject foreign run data or unknown phases', () => {
  const runId = id(99), timing = startupTiming(runId, 'claude_code')
  const record = { sampleId: 'timings', runIdHash: timing.runIdHash, harness: 'claude_code' }
  const item = stage('agent_start', 3500)
  item.chunk.data.startupTiming = { ...timing, privateToken: 'PRIVATE', phases: timing.phases.map(phase => ({ ...phase, prompt: 'PRIVATE' })) }
  observeChunks(record, { chunks: [item] }, epoch + 4000)
  assert.deepEqual(record.daemonStartupTiming, timing)
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE|prompt|privateToken/)
  for (const invalid of [{ ...timing, runIdHash: '0'.repeat(16) }, { ...timing, harness: 'codex' },
    { ...timing, phases: [{ ...timing.phases[0], name: 'daemon.adapter.PRIVATE' }] },
    { ...timing, phases: Array.from({ length: 65 }, () => timing.phases[0]) }]) {
    const invalidRecord = { runIdHash: timing.runIdHash, harness: 'claude_code' }
    item.chunk.data.startupTiming = invalid
    observeChunks(invalidRecord, { chunks: [item] }, epoch + 4000)
    assert.equal(invalidRecord.startupTimingStatus, 'invalid')
    assert.equal(invalidRecord.daemonStartupTiming, undefined)
    assert.doesNotMatch(JSON.stringify(invalidRecord), /PRIVATE/)
  }
})

test('candidate gate checks frozen device and marker without representing itself as cloud latency acceptance', async () => {
  const io = fixture({ candidate: true })
  const report = await runCloudStartup(options(['--mode', 'candidate', '--runs', '1', '--harness', 'codex', '--device-id', deviceId, '--agent-id', agentId]), { env, ...io })
  assert.equal(report.status, 'candidate_subscription_proved', JSON.stringify(report))
  assert.equal(report.target, 'candidate_device'); assert.equal(report.samples[0].execution.deviceId, deviceId)
  assert.equal(report.samples[0].replyVerified, true)
  assert.equal(io.calls.some(call => call.path.endsWith('/machine')), false)
})

test('wrong provenance or cleanup failure fails and still signs out; completed stop races are confirmed', async () => {
  for (const behavior of [{ badEvidence: true }, { failDelete: true }]) {
    const io = fixture(behavior), report = await runCloudStartup(options(), { env, ...io })
    assert.equal(report.status, 'failed'); assert.ok(io.samples.every(sample => sample.cancelled && sample.machineEnded))
    assert.equal(io.calls.filter(call => call.path === '/api/auth/sign-out').length, 1)
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/)
  }
  const io = fixture({ stopRace: true }), report = await runCloudStartup(options(), { env, ...io })
  assert.equal(report.status, 'awaiting_server_timings', JSON.stringify(report))
  assert.ok(io.samples.every(sample => sample.reads === 4))
})

test('an existing non-test Bot is never interrupted', async () => {
  const io = fixture({ badBot: true }), report = await runCloudStartup(options(['--bot-id', botId]), { env, ...io })
  assert.equal(report.status, 'failed'); assert.equal(report.error, 'startup_test_bot_required')
  assert.equal(io.calls.some(call => call.init.body?.includes('stopCoordinatorTurn')), false)
  assert.equal(io.samples.length, 0)
})

test('worker configuration is pinned before and after every case and never exposes other environment values', async () => {
  const keys = ['MIKKA_CLOUD_WORKER_SHA', 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT', 'E2B_BYO_COMPUTER_TEMPLATE', 'E2B_CLAUDE_TEMPLATE', 'E2B_CODEX_TEMPLATE']
  const values = ['a'.repeat(40), 'b'.repeat(40), 'desktop', 'claude', 'codex']
  const readPaths = []
  const release = await readProductionWorkerRelease({ token: 'PRIVATE_VERCEL', fetchImpl: async url => {
    readPaths.push(url.pathname)
    if (url.pathname.startsWith('/v10/')) return Response.json({ envs: [...keys.map((key, index) => ({ key, id: String(index), target: ['production'] })),
      { key: 'PRIVATE_UNRELATED_KEY', id: 'do-not-read', target: ['production'] }] })
    return Response.json({ value: values[Number(url.pathname.split('/').at(-1))] })
  } })
  assert.equal(readPaths.length, 6); assert.ok(readPaths.every(path => !path.includes('do-not-read')))
  assert.doesNotMatch(JSON.stringify(release), /PRIVATE/)
  let checks = 0
  const io = fixture(), report = await runCloudStartup(options(['--expected-worker-sha', values[0], '--expected-worker-source', values[1]]),
    { env, ...io, readWorkerRelease: async () => { checks++; return checks >= 4 ? { ...release, workerSha: 'c'.repeat(40) } : release } })
  assert.equal(report.status, 'failed'); assert.equal(io.samples.length, 1, 'a changed release prevents later dispatches')
  assert.equal(report.error, 'startup_worker_release_mismatch')
})

test('alignment rejects missing, ambiguous and reversed clocks; baseline does not silently become a passing threshold', () => {
  const make = () => ({ mode: 'acceptance', target: 'cloud', maxStartupMs: 5000, cleanup: { errors: [] },
    samples: [0, 1, 2].map(n => ({ workflowRunId: `wrun_${n}`, execution: { credentialType: 'subscription' }, cleanup: { status: 'passed' },
      agentStart: { storedAt: new Date(epoch + 6000).toISOString() }, firstProviderChunk: { storedAt: new Date(epoch + 6100).toISOString() } })) })
  const logs = [0, 1, 2].map(n => ({ msg: 'dispatch_timing', workflowRunId: `wrun_${n}`, startedAt: epoch, endedAt: epoch + 4000, totalMs: 4000, failed: false }))
  assert.equal(alignServerTimings(make(), logs).status, 'failed')
  assert.equal(alignServerTimings({ ...make(), mode: 'baseline' }, logs).status, 'baseline_recorded')
  assert.equal(alignServerTimings(make(), []).samples[0].timing.reason, 'dispatch_log_missing')
  assert.equal(alignServerTimings(make(), [...logs, logs[0]]).samples[0].timing.reason, 'ambiguous_dispatch')
  assert.equal(alignServerTimings(make(), logs.map(log => ({ ...log, startedAt: epoch + 7000, endedAt: epoch + 8000 }))).samples[0].timing.reason, 'clock_or_receipt_invalid')
})
