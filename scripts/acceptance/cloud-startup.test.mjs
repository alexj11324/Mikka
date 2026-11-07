import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'
import { alignServerTimings, cleanupCase, createSessionClient, observeChunks, parseOptions, readProductionWorkerRelease, runCloudStartup, sampledRequestTrace } from './cloud-startup.mjs'
import { readMcpHttpTiming, readRuntimeTiming, runtimeEvidence } from './cloud-startup-evidence.mjs'
import { secretActionAllowed } from '../../lib/secrets/permissions.ts'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const workspace = id(1), botId = id(2), deviceId = id(3), agentId = id(4)
const personalWorkspace = id(9), ownerId = 'PRIVATE_SMOKE_USER', adminId = 'PRIVATE_TEAM_ADMIN'
const epoch = Date.parse('2026-11-06T12:00:00.000Z')
const env = { SMOKE_OWNER_EMAIL: 'acceptance+mikka-smoke@example.invalid', SMOKE_OWNER_PASSWORD: 'PRIVATE_PASSWORD' }
const models = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const options = (extra = []) => parseOptions(['--workspace', workspace, '--timeout-ms', '1000', ...extra], {})
const stage = (name, at, ok = true) => ({ at: new Date(epoch + at).toISOString(), chunk: { type: 'data-run-stage', data: { stage: name, ms: 300, ok } } })
const delta = (text, at = 4000) => ({ at: new Date(epoch + at).toISOString(), chunk: { type: 'text-delta', delta: text } })
const startupTiming = (runId, harness) => ({ version: 1, runIdHash: createHash('sha256').update(runId).digest('hex').slice(0, 16),
  harness, startedAt: epoch + 3000, endedAt: epoch + 3450, ms: 450, outcome: 'ok', truncated: false,
  phases: [{ name: 'daemon.adapter.cli_init', startMs: 50, endMs: 400, ms: 350, outcome: 'ok' }] })
const startedStage = sample => { const item = stage('agent_start', 3500); item.chunk.data.startupTiming = startupTiming(sample.runId, sample.harness); return item }
const runtimeTiming = sample => ({ version: 1, source: 'http_server_link', window: 'run_launch_to_agent_exit',
  scope: 'daemon_http_server_link_and_task_fetch', allFirstPartyHttpComplete: false,
  runIdHash: createHash('sha256').update(sample.runId).digest('hex').slice(0, 16), harness: sample.harness,
  startedAt: epoch + 1000, endedAt: epoch + 6000, ms: 5000, executionStartMs: 2500, executionEndMs: 4000,
  agentAccepted: { kind: sample.harness === 'codex' ? 'codex_turn_start_ack' : 'claude_user_ack', at: epoch + 3500, ms: 2500 },
  complete: true, truncated: false, requests: [{ sequence: 1, endpoint: 'run_telemetry', phase: 'executing', method: 'POST', shared: false,
    startMs: 3000, endMs: 3010, ms: 10, outcome: 'ok' }],
  counts: [{ endpoint: 'run_telemetry', phase: 'executing', shared: false, started: 1, completed: 1, errors: 0, ms: 10 }],
  providerOutputChunks: 2, toolCallsStarted: 1, toolCallsCompleted: 1, toolCallsFailed: 0,
  mcpHttpTiming: { version: 1, source: 'mikka_mcp_physical_fetch', scope: 'observed_mikka_mcp_children', generationCoverage: 'unverified',
    allFirstPartyHttpComplete: false, remoteMcpServerCount: 0, childPathAuditVersion: 1,
    runIdHash: createHash('sha256').update(sample.runId).digest('hex').slice(0, 16), harness: sample.harness,
    startedAt: epoch + 2000, endedAt: epoch + 5500, expectedChildren: 1, observedChildren: 1, closedChildren: 0,
    observedComplete: true, childLifecycleComplete: false, rejectedEvents: 0, truncated: false,
    children: [{ child: 1, startedAt: epoch + 2100, closedAt: null, lastSequence: 3, sent: 1, completed: 1, lost: 0 }],
    requests: [{ child: 1, sequence: 1, operation: 'decision_catalogue', startedAt: epoch + 2200,
      endedAt: epoch + 2250, durationMs: 50, status: 200, outcome: 'ok' }] },
  officialCliTiming: { version: 1, source: 'official_cli_otlp', runIdHash: createHash('sha256').update(sample.runId).digest('hex').slice(0, 16),
    harness: sample.harness, startedAt: epoch + 2000, endedAt: epoch + 5500, collection: 'best_effort', flush: 'not_confirmed',
    cliExitObserved: true, batches: 1, recordsReceived: 1, duplicates: 0, rejectedBatches: 0, invalidEvents: 0, ignoredRecords: 0, truncated: false,
    events: [{ name: `${sample.harness}.api_request`, kind: 'provider', receivedAt: epoch + 4900, eventAt: epoch + 4000,
      durationMs: 1000, model: models[sample.harness], outcome: 'ok', status: 200, attempt: 1, sequence: 2 }] } })

function fixture({ candidate = false, badEvidence = false, badBot = false, failDelete = false, stopRace = false, runtime = false, extraAuth = false, deferTerminal = false,
  wrongPayer = false, wrongScope = false, wrongProfile = false, wrongSource = false, ambiguousSource = false, withdrawShare = false, checkingMenu = false, remapCurrentId = false, fallbackMenu = false, failRestore = false,
  workspaceRole = 'member', timingSecret = false } = {}) {
  const calls = [], samples = [], profiles = new Map(), sockets = []
  let current, clock = epoch, profileCount = 0
  let chosenModel
  const json = value => Response.json(value)
  const rpc = result => json({ version: 1, ok: true, result })
  const readDetail = sample => {
    sample.reads++
    if (candidate && runtime && sample.reads > 1 && !deferTerminal) sample.finished = true
    const detail = { thread: { id: sample.runId, status: sample.finished ? 'stopped' : sample.reads > 1 ? 'running' : 'preparing', createdAt: new Date(epoch).toISOString() },
      chunks: sample.reads > 1 ? [stage('repository', 1000), startedStage(sample),
        { at: new Date(epoch + 3700).toISOString(), chunk: { type: 'tool-input-start', toolCallId: 'safe-id' } },
        { at: new Date(epoch + 3800).toISOString(), chunk: { type: 'tool-output-available', toolCallId: 'safe-id', output: 'PRIVATE_README_CONTENT' } },
        delta('PRIVATE_PROVIDER_OUTPUT STARTUP_'), delta(`OK_${sample.marker}`, 4100), ...(runtime ? [{ at: new Date(epoch + 6000).toISOString(),
          chunk: { type: 'finish', messageMetadata: { mikkaRuntimeTiming: (() => { const value = runtimeTiming(sample)
            if (extraAuth) { value.requests[0].endpoint = 'permission_check'; value.counts[0].endpoint = 'permission_check' }; return value })() } } }] : [])] : [stage('repository', 1000)],
      live: { runs: [{ id: sample.runId, workspaceId: workspace }] } }
    detail.thread.latestRunId = sample.runId
    detail.thread.attempts = [{ runId: sample.runId, status: detail.thread.status }]
    io.onDetail?.(sample, detail)
    return detail
  }
  const io = {
    calls, samples, sockets, now: () => clock += 10,
    pushTerminal() {
      current.finished = true
      for (const socket of sockets) if (!socket.closed) socket.onmessage?.({ data: JSON.stringify({ kind: 'run', id: current.runId }) })
    },
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
        assert.deepEqual(JSON.parse(init.body), { email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD, rememberMe: false })
        return Response.json({}, { headers: { 'set-cookie': 'session=PRIVATE_COOKIE; Path=/; Secure; HttpOnly' } })
      }
      assert.match(init.headers.cookie ?? '', /session=PRIVATE_COOKIE/)
      if (path === '/api/auth/get-session') return json({ user: { id: ownerId, email: env.SMOKE_OWNER_EMAIL } })
      if (path === '/api/auth/sign-out') return Response.json({}, { headers: { 'set-cookie': 'session=; Max-Age=0' } })
      if (path === '/api/workspace') {
        const selected = url.searchParams.get('workspace') ?? (/mikka-workspace=([^;]+)/.exec(init.headers.cookie)?.[1] ?? personalWorkspace)
        return json({ currentUserId: ownerId, workspace: { id: selected, kind: selected === workspace ? 'team' : 'personal' },
          role: selected === workspace ? workspaceRole : 'admin', choices: [{ id: personalWorkspace, kind: 'personal' }, { id: workspace, kind: 'team' }],
          members: selected === workspace ? [{ userId: adminId, email: 'alex@acme.aspectlylabs.com', role: 'admin', status: 'active' }] : [] })
      }
      if (path === `/api/bots/${botId}`) return json({ id: botId, name: badBot ? 'Other real work' : '测试1505 fixture' })
      if (path === '/api/rpc') {
        assert.equal(init.headers.origin, 'https://app.aspectlylabs.com')
        assert.equal(init.headers['x-mikka-rpc'], '1')
        const { action, args } = JSON.parse(init.body)
        if (action === 'workspace.switchWorkspace') {
          if (failRestore && args[0] === personalWorkspace) return Response.json({ error: 'PRIVATE_RESTORE_FAILURE' }, { status: 409 })
          return Response.json({ version: 1, ok: true, result: { ok: true, data: { workspaceId: args[0] } } },
            { headers: { 'set-cookie': `mikka-workspace=${args[0]}; Path=/` } })
        }
        if (action === 'bots.createBot') return rpc({ id: botId, name: args[0].name })
        if (action === 'workspace-secrets.listSecrets') return rpc({ secrets: timingSecret ? [{ id: id(701), name: 'CLOUD_STARTUP_TIMING' }] : [], role: workspaceRole })
        if (action === 'workspace-secrets.createSecret') {
          assert.ok(secretActionAllowed(workspaceRole, 'secret.create', [{ scopeType: 'repository' }]))
          assert.equal(args[0].name, 'CLOUD_STARTUP_TIMING'); assert.equal(args[0].value, '1')
          assert.deepEqual(args[0].scope, { type: 'repository', repository: 'alexj11324/Mikka-handoff' })
          return rpc({ id: id(700), name: args[0].name })
        }
        if (action === 'workspace-secrets.deleteSecret') {
          assert.ok(secretActionAllowed(workspaceRole, 'secret.delete'))
          assert.equal(args[0].id, id(700)); return rpc({ id: id(700) })
        }
        if (action === 'model-order.getModelOrder') {
          const candidates = Object.entries(models).map(([harness, model], index) => ({ harness, model, provider: harness === 'codex' ? 'codex' : 'claude',
            credentialOwnerId: wrongSource ? ownerId : adminId, source: { kind: 'subscription', connectionId: id(50 + index) } }))
          if (ambiguousSource) candidates.push({ ...candidates[0], source: { kind: 'subscription', connectionId: id(59) } })
          return rpc({ candidates })
        }
        if (action === 'execution-settings.getBotModelMenu' || action === 'execution-settings.chooseBotModel') {
          assert.equal(args[0], botId)
          if (action === 'execution-settings.chooseBotModel') {
            if (withdrawShare) return rpc({ ok: false, error: 'executionAccountUnavailable' })
            chosenModel = Object.entries(models).map(([harness, modelId], index) => ({ id: id(60 + index), modelId, provider: harness === 'codex' ? 'codex' : 'claude' })).find(item => item.id === args[1])
            assert.ok(chosenModel)
          }
          return rpc({ groups: Object.entries(models).map(([harness, modelId], index) => ({ kind: 'subscription', provider: harness === 'codex' ? 'codex' : 'claude', owner: 'Shared member',
            options: [{ id: id(60 + index), modelId, provider: harness === 'codex' ? 'codex' : 'claude' }] })),
            current: chosenModel ? { ...chosenModel, ...(remapCurrentId ? { id: id(850) } : {}), ...(fallbackMenu ? { fallback: 'quota' } : {}),
              kind: 'subscription', chosen: true, available: !checkingMenu, availability: checkingMenu ? 'checking' : 'available' } : null })
        }
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
          assert.deepEqual(args[4], candidate ? { kind: 'device', deviceId } : { $mikka: 'undefined' }, 'cloud chat must not assert the structured new-task destination')
          assert.equal(args[8], input.profileId, 'the real human submission still selects the authorized profile')
          current.harness = profiles.get(input.profileId).harness; current.profileId = input.profileId
          assert.equal(chosenModel?.modelId, models[current.harness], 'the coordinator must use the same explicitly chosen small subscription model')
          current.marker = input.note.match(/STARTUP_OK_([A-Za-z0-9_-]+)/)[1]
          assert.match(init.headers.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/)
          return rpc({ queued: true })
        }
        if (action === 'coordinator.stopCoordinatorTurn') return rpc({ stopped: true })
        if (action === 'agents.pollIssueThreads') return rpc({ threads: [{ id: current.runId, ownedByCurrentUser: true }] })
        if (action === 'agents.getIssueThread') return rpc(readDetail(samples.find(sample => sample.runId === args[1])))
        if (action === 'agents.getThreadMachine') {
          assert.deepEqual(args, [current.issueId, current.runId])
          return rpc({ kind: 'cloud', state: current.machineEnded ? 'ended' : 'running',
            cloud: current.machineEnded ? null : { sandboxId: 'fixture-vm', template: 'fixture' } })
        }
        if (action === 'agents.stopRun') {
          current.stopRequested = true; current.finished ||= !deferTerminal
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
        const body = JSON.parse(init.body), profile = { ...body.profile, id: id(500 + ++profileCount), version: 1, digest: 'e'.repeat(64) }
        assert.equal(body.workspaceId, workspace)
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
        subscriptionRoute: current.harness === 'codex' ? 'codex_cli' : 'claude_code_cli', agentProfile: { profileId: current.profileId, version: 1, digest: wrongProfile ? 'f'.repeat(64) : profiles.get(current.profileId).digest, source: 'explicit' },
        executionIdentity: { version: 1, requester: ownerId, executionPrincipal: ownerId, botId, botOwner: ownerId, outputOwner: ownerId,
          workspaceId: wrongScope ? personalWorkspace : workspace, personalResourcePolicy: 'requester_only',
          billingAccount: { model: { kind: 'subscription', ownerId: wrongPayer ? ownerId : adminId, resourceId: id(800) }, runtime: { kind: candidate ? 'local_device' : 'e2b', ownerId, resourceId: candidate ? deviceId : ownerId } },
          resourceBindings: [{ kind: 'device', id: deviceId, ownerId, access: 'owner' }, { kind: 'subscription', id: id(800), ownerId: adminId, access: 'workspace_share', revision: '2' }] } } })
      if (path === '/api/live/ticket') return json({ url: 'wss://live.example/v1/live/opaque/socket', protocol: 'PRIVATE_LIVE_TICKET', expiresAt: epoch + 300000 })
      if (path === '/api/factory/tasks') return json({ contractVersion: 1, issueId: current.issueId, tasks: [{ id: current.taskId, issueId: current.issueId }] })
      if (path === `/api/factory/tasks/${current.taskId}`) {
        if (init.method === 'POST') { current.cancelled = true; current.finished ||= !stopRace && !deferTerminal; return json({ cancelled: true }) }
        return json({ task: { id: current.taskId, issueId: current.issueId, status: 'running', revision: 1 }, attempts: [{ runId: current.runId }] })
      }
      if (/^\/api\/threads\/.*\/machine$/.test(path)) {
        assert.equal(candidate, false); assert.equal(path, `/api/threads/${current.runId}/machine`)
        current.machineEnded = true; return json({ runId: current.runId, state: 'ended' })
      }
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

test('an early marker stays before the tool when full run history is replayed', () => {
  const record = { sampleId: 'ordered', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
  const detail = { chunks: [stage('agent_start', 20), delta('STARTUP_OK_ordered'),
    { chunk: { type: 'tool-input-start', toolCallId: 'read-file' } },
    { chunk: { type: 'tool-output-available', toolCallId: 'read-file', output: 'PRIVATE_README_CONTENT' } }] }
  for (let read = 0; read < 3; read++) {
    assert.equal(observeChunks(record, detail, epoch + read), false)
    assert.equal(record.replyVerified, true)
    assert.equal(record.toolCalls[0].outcome, 'ok')
    assert.equal(record.replyVerifiedAfterTool, false, 'previously accumulated tools cannot reorder a replayed marker')
  }
  detail.chunks.push(delta('An unrelated later reply'))
  assert.equal(observeChunks(record, detail, epoch + 10), false, 'old marker text cannot carry into the post-tool buffer')
  const baseline = { sampleId: 'ordered', requireReply: true, minToolCalls: 1 }
  assert.equal(observeChunks(baseline, detail, epoch), true, 'optional baseline keeps its original reply-plus-tool criterion')
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_ordered/)
})

test('a completed tool followed by the task marker proves reply order', () => {
  const record = { sampleId: 'ordered', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
  const detail = { chunks: [stage('agent_start', 20),
    { chunk: { type: 'tool-input-start', toolCallId: 'read-file' } },
    { chunk: { type: 'tool-output-available', toolCallId: 'read-file', output: 'PRIVATE_README_CONTENT' } },
    delta('STARTUP_'), delta('OK_ordered')] }
  assert.equal(observeChunks(record, detail, epoch), true)
  assert.equal(record.replyVerifiedAfterTool, true)
  assert.equal(observeChunks(record, detail, epoch + 10), true)
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_ordered/)
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
  assert.equal(report.team.teamWorkspaceConfirmed, true)
  assert.equal(report.cleanup.workspaceRestored, true)
  assert.equal(report.botRetention, 'retained_no_delete_api')
  assert.equal(io.calls.filter(call => call.init.body?.includes('execution-settings.chooseBotModel')).length, 3)
  assert.ok(io.calls.filter(call => call.init.body?.includes('model-order.')).every(call => JSON.parse(call.init.body).action === 'model-order.getModelOrder'))
  assert.ok(io.calls.some(call => call.init.headers.cookie?.includes(`mikka-workspace=${workspace}`)))
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|alex@|cookie|ticket/i)
  const logs = report.samples.map(sample => ({ msg: 'dispatch_timing', workflowRunId: sample.workflowRunId, stepId: 'step',
    startedAt: epoch, endedAt: epoch + 2000, totalMs: 2000, failed: false, phases: [{ phase: 'resolveModel', ms: 20 }] }))
  const aligned = alignServerTimings(report, logs)
  assert.equal(aligned.status, 'baseline_recorded')
  assert.ok(aligned.samples.every(sample => sample.timing.dispatchToAgentStartMs === 3500 && sample.timing.dispatchToFirstProviderChunkMs === 3700))
})

test('SMOKE chooses the verified team without fixed IDs and accepts checking quota with a new catalogue clone ID', async () => {
  const io = fixture({ checkingMenu: true, remapCurrentId: true })
  const report = await runCloudStartup(parseOptions(['--timeout-ms', '1000'], {}), { env, ...io })
  assert.equal(report.status, 'awaiting_server_timings', JSON.stringify(report))
  assert.equal(report.cleanup.workspaceRestored, true)
  assert.ok(report.samples.every(sample => sample.execution.identity.subscriptionAccess[0] === 'workspace_share'))
  await assert.rejects(runCloudStartup(options(), { env: { ACME_DEMO_EMAIL: env.SMOKE_OWNER_EMAIL, ACME_DEMO_PASSWORD: env.SMOKE_OWNER_PASSWORD }, ...io }), /startup_smoke_account_required/)
})

test('foreign payer, workspace or frozen profile cannot satisfy the shared subscription receipt', async () => {
  for (const failure of [{ wrongPayer: true }, { wrongScope: true }, { wrongProfile: true }]) {
    const io = fixture(failure), report = await runCloudStartup(options(), { env, ...io })
    assert.equal(report.status, 'failed')
    assert.ok(report.samples.every(sample => sample.error === 'startup_shared_subscription_identity_mismatch'))
    assert.ok(io.samples.every(sample => sample.cancelled && sample.deleted && sample.machineEnded))
    assert.equal(report.cleanup.workspaceRestored, true)
    assert.equal(io.calls.at(-1).path, '/api/auth/sign-out')
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|example.invalid|alex@/)
  }
})

test('wrong or ambiguous sources and sharing revoked during choice fail before dispatch without changing preferences', async () => {
  for (const failure of [{ wrongSource: true }, { ambiguousSource: true }, { withdrawShare: true }, { fallbackMenu: true }]) {
    const io = fixture(failure), report = await runCloudStartup(options(), { env, ...io })
    assert.equal(report.status, 'failed')
    assert.equal(report.cleanup.workspaceRestored, true)
    assert.ok(report.samples.some(sample => sample.status === 'failed'))
    if (!failure.ambiguousSource) assert.equal(io.samples.length, 0)
    else assert.deepEqual(io.samples.map(sample => sample.harness), ['codex'], 'the independent provider still runs')
    assert.ok(io.calls.filter(call => call.init.body?.includes('model-order.')).every(call => JSON.parse(call.init.body).action === 'model-order.getModelOrder'))
    assert.equal(io.calls.at(-1).path, '/api/auth/sign-out')
  }
})

test('workspace restore failure is visible but never suppresses profile cleanup or sign-out', async () => {
  const io = fixture({ failRestore: true }), report = await runCloudStartup(options(), { env, ...io })
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.cleanup.errors.map(row => row.step), ['workspace_restore'])
  assert.equal(io.calls.filter(call => call.init.method === 'DELETE' && call.path.startsWith('/api/factory/agent-profiles/')).length, 2)
  assert.equal(io.calls.at(-1).path, '/api/auth/sign-out')
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

test('the scoped runtime receipt gates direct execution, preserves only closed evidence and does not claim OTLP completeness', () => {
  const sample = { runId: id(999), harness: 'codex', sampleId: 'proof', requireRuntimeReceipt: true, requireOfficialTiming: true }
  const value = runtimeTiming(sample)
  sample.runIdHash = value.runIdHash
  value.private = 'PRIVATE'; value.requests[0].path = 'PRIVATE'; value.officialCliTiming.events[0].error = 'PRIVATE'
  assert.equal(observeChunks(sample, { chunks: [startedStage(sample), delta('STARTUP_OK_proof')] }, epoch + 4000), false)
  assert.equal(observeChunks(sample, { chunks: [startedStage(sample), delta('STARTUP_OK_proof'),
    { chunk: { type: 'finish', messageMetadata: { mikkaRuntimeTiming: value } } }] }, epoch + 6000), true)
  assert.equal(sample.runtimeEvidence.status, 'passed')
  assert.equal(sample.runtimeEvidence.extraRemoteCalls, 0)
  assert.equal(sample.runtimeEvidence.officialDelivery, 'best_effort_not_a_complete_call_count')
  assert.doesNotMatch(JSON.stringify(sample), /PRIVATE|"(?:path|error)":/)
  const invalid = structuredClone(value); invalid.counts[0].started = 0
  assert.equal(readRuntimeTiming(invalid, sample), null)
  const missing = structuredClone(sample.runtimeTiming); delete missing.officialCliTiming
  assert.equal(runtimeEvidence(missing, { requireOfficial: true }).status, 'unavailable')
  const hiddenProxy = structuredClone(sample.runtimeTiming)
  hiddenProxy.counts[0].endpoint = 'provider_proxy'; hiddenProxy.counts[0].phase = 'preparing'
  assert.equal(runtimeEvidence(hiddenProxy).status, 'failed')
})

test('an HTTP-only legacy receipt cannot prove child-send coverage', () => {
  const value = runtimeTiming({ runId: id(998), harness: 'codex' })
  delete value.mcpHttpTiming
  delete value.scope
  delete value.allFirstPartyHttpComplete
  const parsed = readRuntimeTiming(value, { runIdHash: value.runIdHash, harness: value.harness })
  const required = runtimeEvidence(parsed)
  assert.equal(required.status, 'unavailable')
  assert.equal(required.allFirstPartyHttpComplete, false)
  assert.equal(required.reason, 'mcp_http_observation_missing')
})

test('child business observations cannot become global coverage or fail solely for a missing lifecycle close', () => {
  const value = runtimeTiming({ runId: id(997), harness: 'claude_code' }), scope = { runIdHash: value.runIdHash, harness: value.harness }
  value.mcpHttpTiming.privateToken = 'PRIVATE'
  value.mcpHttpTiming.requests[0].url = 'PRIVATE'
  const parsed = readRuntimeTiming(value, scope), proof = runtimeEvidence(parsed)
  assert.equal(proof.status, 'passed')
  assert.equal(proof.basis, 'host_authorization_census_and_closed_mcp_business_paths')
  assert.equal(proof.hostAuthorizationComplete, true)
  assert.equal(proof.allFirstPartyHttpComplete, false)
  assert.equal(proof.childBusiness.generationCoverage, 'unverified')
  assert.equal(proof.childBusiness.childLifecycleComplete, false)
  assert.equal(proof.childBusiness.observedPhysicalSends, 1)
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE|privateToken|url/)
  const pending = structuredClone(parsed)
  pending.mcpHttpTiming.observedComplete = false
  Object.assign(pending.mcpHttpTiming.children[0], { sent: 2, lastSequence: 4 })
  pending.mcpHttpTiming.requests.push({ child: 1, sequence: 2, operation: 'decision_record', startedAt: epoch + 5000,
    endedAt: null, durationMs: null, status: null, outcome: 'pending' })
  const observed = runtimeEvidence(readRuntimeTiming(pending, scope))
  assert.equal(observed.status, 'passed', 'an observed pending business request is not an extra authorization request')
  assert.equal(observed.extraRemoteCalls, 0)
  assert.equal(observed.childBusiness.pendingObservedSends, 1)
  assert.equal(observed.childBusiness.observedComplete, false)
})

test('child evidence rejects foreign identity, fake completeness, malformed sequences and unobserved remote MCP scope', () => {
  const value = runtimeTiming({ runId: id(996), harness: 'codex' }), scope = { runIdHash: value.runIdHash, harness: value.harness }
  for (const mutate of [
    child => { child.runIdHash = '0'.repeat(16) }, child => { child.harness = 'claude_code' },
    child => { child.generationCoverage = 'complete' }, child => { child.allFirstPartyHttpComplete = true },
    child => { delete child.remoteMcpServerCount }, child => { child.childPathAuditVersion = 2 },
    child => { child.childLifecycleComplete = true }, child => { child.requests[0].operation = 'permission_check' },
    child => { child.requests[0].sequence = 2 }, child => { child.children[0].lastSequence = 4 },
    child => { child.requests[0].endedAt = null }, child => { child.requests.push({ ...child.requests[0] }) },
    child => { child.requests[0].status = 503 }, child => { child.requests[0].status = null },
  ]) {
    const invalid = structuredClone(value); mutate(invalid.mcpHttpTiming)
    assert.equal(readMcpHttpTiming(invalid.mcpHttpTiming, scope), null)
    const proof = runtimeEvidence(readRuntimeTiming(invalid, scope))
    assert.equal(proof.status, 'unavailable')
    assert.equal(proof.reason, 'mcp_http_observation_invalid')
  }
  for (const mutate of [
    child => { child.remoteMcpServerCount = 1 },
    child => { child.observedComplete = false; child.rejectedEvents = 1 },
    child => { child.observedComplete = false; child.truncated = true },
    child => { child.observedComplete = false; child.children[0].lost = 1 },
    child => { child.requests[0].operation = 'decision_record' },
  ]) {
    const incomplete = structuredClone(value); mutate(incomplete.mcpHttpTiming)
    const parsed = readRuntimeTiming(incomplete, scope)
    assert.ok(parsed.mcpHttpTiming)
    assert.equal(runtimeEvidence(parsed).status, 'unavailable')
  }
})

test('direct diagnostics use and delete only this test repository variable, and extra auth fails after cleanup', async () => {
  for (const extraAuth of [false, true]) {
    const io = fixture({ runtime: true, extraAuth, workspaceRole: 'admin' })
    const report = await runCloudStartup(options(['--runtime-evidence', 'required', '--official-timing', 'enabled']), { env, ...io })
    assert.equal(report.status, extraAuth ? 'failed' : 'awaiting_server_timings', JSON.stringify(report))
    assert.ok(report.samples.every(sample => sample.runtimeEvidence?.status === (extraAuth ? 'failed' : 'passed')))
    assert.ok(report.samples.every(sample => sample.requireReplyAfterTool === true && sample.replyVerifiedAfterTool === true))
    assert.equal(report.officialTiming.cleaned, true)
    assert.ok(report.samples.every(sample => sample.cleanup.status === 'passed'))
    assert.equal(io.calls.filter(call => call.init.body?.includes('workspace-secrets.deleteSecret')).length, 1)
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE/)
  }
})

test('member candidate diagnostics use the trusted host without reading or writing workspace secrets', async () => {
  for (const harness of ['claude_code', 'codex']) for (const timingSecret of [false, true]) {
    const io = fixture({ candidate: true, runtime: true, timingSecret })
    const report = await runCloudStartup(options(['--mode', 'candidate', '--runs', '1', '--harness', harness,
      '--device-id', deviceId, '--agent-id', agentId, '--runtime-evidence', 'required', '--official-timing', 'enabled']), { env, ...io })
    assert.equal(report.status, 'candidate_subscription_proved', JSON.stringify(report))
    assert.deepEqual(report.officialTiming, { enabled: true, source: 'trusted_host', scope: 'candidate_device', variableCreated: false, cleaned: true })
    assert.ok(report.samples.every(sample => sample.requireOfficialTiming && sample.requireRuntimeReceipt
      && sample.runtimeEvidence?.status === 'passed' && sample.cleanup.status === 'passed'))
    assert.equal(io.calls.some(call => call.init.body?.includes('workspace-secrets.')), false)
    assert.equal(report.cleanup.workspaceRestored, true)
    assert.equal(io.calls.at(-1).path, '/api/auth/sign-out')
  }
})

test('trusted candidate timing still refuses missing official CLI or MCP observations', async () => {
  for (const field of ['officialCliTiming', 'mcpHttpTiming']) {
    const io = fixture({ candidate: true, runtime: true })
    io.onDetail = (_sample, detail) => {
      for (const item of detail.chunks) if (item.chunk?.messageMetadata?.mikkaRuntimeTiming) delete item.chunk.messageMetadata.mikkaRuntimeTiming[field]
    }
    const report = await runCloudStartup(options(['--mode', 'candidate', '--runs', '1', '--harness', 'codex',
      '--device-id', deviceId, '--agent-id', agentId, '--runtime-evidence', 'required', '--official-timing', 'enabled']), { env, ...io })
    assert.equal(report.status, 'failed')
    assert.equal(report.samples[0].error, 'startup_runtime_evidence_failed')
    assert.equal(report.samples[0].cleanup.status, 'passed')
    assert.equal(io.calls.some(call => call.init.body?.includes('workspace-secrets.')), false)
  }
})

test('member production acceptance observes its dedicated Bot window without reading or writing workspace secrets', async () => {
  for (const harness of ['claude_code', 'codex']) for (const timingSecret of [false, true]) {
    const io = fixture({ runtime: true, timingSecret })
    const report = await runCloudStartup(options(['--mode', 'acceptance', '--runs', '3', '--harness', harness,
      '--expected-build', 'BUILD1', '--revision', 'a'.repeat(40), '--bot-id', botId]), { env, ...io })
    assert.equal(report.status, 'awaiting_server_timings', JSON.stringify(report))
    assert.deepEqual(report.officialTiming, { enabled: true, source: 'trusted_claim', scope: 'dedicated_bot_repository_window',
      botId, variableCreated: false, cleaned: true })
    assert.equal(report.samples.length, 3)
    assert.ok(report.samples.every(sample => sample.requireOfficialTiming && sample.requireRuntimeReceipt
      && sample.runtimeEvidence?.status === 'passed' && sample.cleanup.status === 'passed'))
    assert.equal(io.calls.some(call => call.init.body?.includes('workspace-secrets.')), false)
    assert.equal(report.cleanup.workspaceRestored, true)
    assert.equal(io.calls.at(-1).path, '/api/auth/sign-out')
  }
})

test('trusted cloud timing refuses missing CLI/MCP observations and extra remote authorization', async () => {
  for (const field of ['officialCliTiming', 'mcpHttpTiming', 'extraAuth']) {
    const io = fixture({ runtime: true, extraAuth: field === 'extraAuth' })
    io.onDetail = (_sample, detail) => {
      for (const item of detail.chunks) if (item.chunk?.messageMetadata?.mikkaRuntimeTiming && field !== 'extraAuth')
        delete item.chunk.messageMetadata.mikkaRuntimeTiming[field]
    }
    const report = await runCloudStartup(options(['--mode', 'acceptance', '--runs', '3', '--harness', 'codex',
      '--expected-build', 'BUILD1', '--revision', 'a'.repeat(40), '--bot-id', botId]), { env, ...io })
    assert.equal(report.status, 'failed')
    assert.equal(report.samples.length, 3)
    assert.ok(report.samples.every(sample => sample.error === 'startup_runtime_evidence_failed' && sample.cleanup.status === 'passed'))
    assert.equal(io.calls.some(call => call.init.body?.includes('workspace-secrets.')), false)
  }
})

test('formal cloud diagnostics require the prepared dedicated Bot before creating task fixtures', async () => {
  const io = fixture({ runtime: true })
  const report = await runCloudStartup(options(['--mode', 'acceptance', '--expected-build', 'BUILD1', '--revision', 'a'.repeat(40)]), { env, ...io })
  assert.equal(report.error, 'startup_diagnostic_bot_required')
  assert.equal(report.status, 'failed')
  assert.equal(io.samples.length, 0)
  assert.equal(io.calls.some(call => call.path === '/api/factory/agent-profiles' || call.init.body?.includes('bots.createBot') || call.init.body?.includes('workspace-secrets.')), false)
  assert.equal(io.calls.at(-1).path, '/api/auth/sign-out')
})

test('optional historical baseline reads keep missing detailed diagnostics unavailable', async () => {
  const io = fixture()
  io.onDetail = (_sample, detail) => {
    for (const item of detail.chunks) if (item.chunk?.type === 'data-run-stage') delete item.chunk.data.startupTiming
  }
  const report = await runCloudStartup(options(), { env, ...io })
  assert.equal(report.status, 'awaiting_server_timings')
  assert.equal(report.samples.length, 3)
  assert.ok(report.samples.every(sample => sample.daemonStartupTiming === undefined && sample.startupTimingStatus !== 'complete'
    && sample.cleanup.status === 'passed'))
})

test('trusted candidate timing cannot claim a host without a pinned device and agent', async () => {
  const io = fixture({ candidate: true, runtime: true })
  const report = await runCloudStartup(options(['--mode', 'candidate', '--runs', '1', '--harness', 'codex',
    '--runtime-evidence', 'required', '--official-timing', 'enabled']), { env, ...io })
  assert.equal(report.status, 'failed')
  assert.equal(report.error, 'startup_candidate_target_invalid')
  assert.equal(io.calls.some(call => call.init.body?.includes('workspace-secrets.')), false)
})

test('member cloud diagnostics fail before creating any variable they cannot delete', async () => {
  const io = fixture({ runtime: true })
  const report = await runCloudStartup(options(['--runtime-evidence', 'required', '--official-timing', 'enabled']), { env, ...io })
  assert.equal(report.status, 'failed')
  assert.equal(report.error, 'startup_timing_variable_cleanup_forbidden')
  assert.equal(io.calls.filter(call => call.init.body?.includes('workspace-secrets.listSecrets')).length, 1)
  assert.equal(io.calls.some(call => /workspace-secrets\.(create|replace|delete)Secret/.test(call.init.body ?? '')), false)
  assert.equal(io.calls.some(call => call.init.body?.includes('bots.createBot') || call.path === '/api/factory/agent-profiles'), false)
  assert.equal(report.cleanup.workspaceRestored, true)
  assert.equal(io.calls.at(-1).path, '/api/auth/sign-out')
})

test('admin diagnostics preserve an existing timing variable without replacing or deleting it', async () => {
  const io = fixture({ runtime: true, workspaceRole: 'admin', timingSecret: true })
  const report = await runCloudStartup(options(['--runtime-evidence', 'required', '--official-timing', 'enabled']), { env, ...io })
  assert.equal(report.status, 'failed')
  assert.equal(report.error, 'startup_timing_variable_exists')
  assert.equal(io.calls.some(call => /workspace-secrets\.(create|replace|delete)Secret/.test(call.init.body ?? '')), false)
  assert.equal(report.cleanup.workspaceRestored, true)
  assert.equal(io.calls.at(-1).path, '/api/auth/sign-out')
})

test('candidate gate checks frozen device and marker without representing itself as cloud latency acceptance', async () => {
  const io = fixture({ candidate: true, runtime: true })
  const report = await runCloudStartup({ ...options(['--mode', 'candidate', '--runs', '1', '--harness', 'codex', '--device-id', deviceId, '--agent-id', agentId]), minToolCalls: 1 }, { env, ...io })
  assert.equal(report.status, 'candidate_subscription_proved', JSON.stringify(report))
  assert.equal(report.target, 'candidate_device'); assert.equal(report.samples[0].execution.deviceId, deviceId)
  assert.equal(report.samples[0].replyVerified, true)
  assert.equal(report.samples[0].requireReplyAfterTool, true)
  assert.equal(report.samples[0].replyVerifiedAfterTool, true)
  assert.equal(io.calls.some(call => call.path.endsWith('/machine')), false)
})

test('candidate finish receipt waits for the same run terminal push before cleanup', async () => {
  const io = fixture({ candidate: true, runtime: true, deferTerminal: true })
  let receiptObserved
  const receipt = new Promise(resolve => { receiptObserved = resolve })
  io.onDetail = (sample, detail) => {
    if (detail.chunks.some(item => item.chunk.type === 'finish')) receiptObserved()
  }
  let settled = false
  const pending = runCloudStartup(options(['--mode', 'candidate', '--runs', '1', '--harness', 'codex', '--device-id', deviceId, '--agent-id', agentId]), { env, ...io })
    .then(report => { settled = true; return report })
  await receipt
  await new Promise(setImmediate)
  assert.equal(settled, false, 'a finish chunk does not attest the server terminal state')
  assert.equal(io.calls.some(call => call.path === '/api/factory/tasks'), false, 'cleanup cannot begin before terminal acknowledgement')
  io.pushTerminal()
  const report = await pending
  assert.equal(report.status, 'candidate_subscription_proved', JSON.stringify(report))
  assert.equal(report.samples[0].lastStatus, 'stopped')
  assert.equal(report.samples[0].cleanup.status, 'passed')
  assert.equal(io.samples[0].deleted, true)
  assert.ok(io.sockets.every(socket => socket.closed))
})

test('candidate failure cleanup waits for actual terminal after an accepted stop request', async () => {
  const io = fixture({ candidate: true, runtime: true, badEvidence: true, deferTerminal: true })
  let stopObserved
  const stopped = new Promise(resolve => { stopObserved = resolve })
  io.onDetail = sample => { if (sample.stopRequested) stopObserved() }
  let settled = false
  const pending = runCloudStartup(options(['--mode', 'candidate', '--runs', '1', '--harness', 'codex', '--device-id', deviceId, '--agent-id', agentId]), { env, ...io })
    .then(report => { settled = true; return report })
  await Promise.race([stopped, pending])
  await new Promise(setImmediate)
  assert.equal(io.samples[0].stopRequested, true)
  assert.equal(settled, false, 'stopRequestedAt alone does not mean the daemon ended')
  assert.equal(io.samples[0].deleted, undefined, 'the owned issue stays available while the run remains live')
  io.pushTerminal()
  const report = await pending
  assert.equal(report.status, 'failed')
  assert.equal(report.samples[0].error, 'startup_subscription_provenance_mismatch')
  assert.equal(report.samples[0].cleanup.status, 'passed', JSON.stringify(report.samples[0].cleanup))
  assert.equal(io.samples[0].deleted, true)
  assert.ok(io.sockets.every(socket => socket.closed))
})

test('candidate cleanup deadline retains its fixture when the daemon never confirms terminal', async () => {
  const io = fixture({ candidate: true, runtime: true, badEvidence: true, deferTerminal: true })
  const report = await runCloudStartup(options(['--mode', 'candidate', '--runs', '1', '--harness', 'codex', '--device-id', deviceId, '--agent-id', agentId]), { env, ...io })
  const sample = report.samples[0]
  assert.equal(report.status, 'failed')
  assert.equal(sample.cleanup.status, 'failed')
  assert.equal(sample.cleanup.errors[0].code, 'startup_cleanup_terminal_timeout')
  assert.deepEqual(sample.cleanup.retainedFixture, { issueId: sample.issueId, runIds: [sample.runId] })
  assert.equal(io.samples[0].deleted, undefined)
  assert.equal(io.samples[0].reads, 4, 'only the initial read, watch opening, live-ready and final deadline read occur')
  assert.ok(io.sockets.every(socket => socket.closed))
  assert.equal(io.calls.filter(call => call.path === '/api/auth/sign-out').length, 1)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/)
})

function continuationCleanupFixture() {
  const root = id(810), child = id(811), issueId = id(812), calls = [], sockets = []
  const record = { runId: root, issueId, title: '测试 1505 queued continuation', status: 'failed', error: 'startup_ended_before_execution_proof' }
  let childStatus = 'queued', stopped
  const stopRequested = new Promise(resolve => { stopped = resolve })
  const client = {
    async json(path) {
      if (path === `/api/factory/tasks?issueId=${issueId}`) return { issueId, tasks: [] }
      assert.equal(path, `/api/live/ticket?workspace=${workspace}`)
      return { url: 'wss://live.example/socket', protocol: 'PRIVATE_LIVE_TICKET', expiresAt: epoch + 300000 }
    },
    async rpc(action, args) {
      calls.push({ action, args })
      if (action === 'agents.getIssueThread') {
        assert.deepEqual(args, [issueId, root])
        return { thread: { id: root, status: 'failed', latestRunId: child,
          attempts: [{ runId: root, status: 'failed' }, { runId: child, status: childStatus }],
          continuation: { id: child, status: childStatus } },
        live: { runs: [{ id: root, workspaceId: workspace }, { id: child, workspaceId: workspace }] } }
      }
      if (action === 'agents.stopRun') {
        assert.deepEqual(args, [root]); stopped()
        return { stoppedRunIds: [child] }
      }
      if (action === 'issues.getIssue') return { issue: { id: issueId, title: record.title, revision: 2 } }
      assert.equal(action, 'issue-operations.setIssueDeleted')
      assert.deepEqual(args, [{ id: issueId, revision: 2 }])
      return { deleted: true }
    },
  }
  const io = { client, record, calls, sockets, stopRequested, now: () => epoch,
    push(kind, runId) { for (const socket of sockets) if (!socket.closed) socket.onmessage?.({ data: JSON.stringify({ kind, id: runId }) }) },
    finishChild() { childStatus = 'cancelled'; io.push('run', child) },
    WebSocketImpl: class {
      constructor() {
        this.readyState = 1; sockets.push(this)
        queueMicrotask(() => { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'live_ready', kinds: ['run', 'thread'] }) }) })
      }
      send(message) { assert.equal(message, 'ping') }
      close() { this.closed = true; this.readyState = 3 }
    },
  }
  return { ...io, root, child }
}

test('candidate cleanup stops a queued continuation after its original run failed and waits for the child push', async () => {
  const io = continuationCleanupFixture()
  let settled = false
  const pending = cleanupCase(io.client, io.record, 'device', { ...io, timeoutMs: 1000 }).then(() => { settled = true })
  await Promise.race([io.stopRequested, pending])
  await new Promise(setImmediate)
  assert.equal(io.calls.filter(call => call.action === 'agents.stopRun').length, 1, 'the terminal parent still addresses its live child through the normal stop API')
  assert.equal(settled, false, 'a queued child is not terminal merely because its parent failed')
  assert.equal(io.calls.some(call => call.action === 'issue-operations.setIssueDeleted'), false)
  const reads = io.calls.filter(call => call.action === 'agents.getIssueThread').length
  io.push('run', id(999))
  await new Promise(setImmediate)
  assert.equal(io.calls.filter(call => call.action === 'agents.getIssueThread').length, reads, 'unrelated run pushes do not read this fixture')
  io.finishChild()
  await pending
  assert.equal(io.calls.filter(call => call.action === 'agents.getIssueThread').length, reads + 1, 'the child push supplies the terminal acknowledgement')
  assert.equal(io.record.cleanup.status, 'passed')
  assert.equal(io.record.cleanup.taskDeleted, true)
  assert.equal(io.record.error, 'startup_ended_before_execution_proof', 'cleanup never changes failed execution evidence')
  assert.ok(io.sockets.every(socket => socket.closed))
})

test('candidate cleanup retains both original and queued continuation IDs when no child terminal arrives', async () => {
  const io = continuationCleanupFixture()
  await cleanupCase(io.client, io.record, 'device', { ...io, timeoutMs: 20 })
  assert.equal(io.record.cleanup.status, 'failed')
  assert.equal(io.record.cleanup.errors[0].code, 'startup_cleanup_terminal_timeout')
  assert.deepEqual(io.record.cleanup.retainedFixture, { issueId: io.record.issueId, runIds: [io.root, io.child] })
  assert.equal(io.calls.some(call => call.action === 'issue-operations.setIssueDeleted'), false)
  assert.equal(io.calls.filter(call => call.action === 'agents.stopRun').length, 1)
  assert.ok(io.sockets.every(socket => socket.closed))
})

test('cloud cleanup follows an adopted VM to its live continuation before ending every owned attempt', async () => {
  const io = continuationCleanupFixture(), endTargets = []
  const json = io.client.json.bind(io.client), rpc = io.client.rpc.bind(io.client)
  let machineLive = true, deleted = false, settled = false
  io.client.json = async (path, init) => {
    if (!path.endsWith('/machine')) return json(path, init)
    assert.equal(JSON.parse(init.body).action, 'end')
    const runId = path.split('/')[3]
    assert.ok([io.root, io.child].includes(runId))
    endTargets.push(runId)
    // Adoption left the old row ended with no sandbox. Ending that row cannot
    // release the same sandbox now owned by the continuation.
    if (runId === io.child) machineLive = false
    return { runId, state: 'ended' }
  }
  io.client.rpc = async (action, args) => {
    if (action === 'agents.getThreadMachine') {
      assert.deepEqual(args, [io.record.issueId, io.root])
      return { kind: 'cloud', state: machineLive ? 'running' : 'ended',
        cloud: machineLive ? { sandboxId: 'fixture-current-vm', template: 'fixture' } : null }
    }
    if (action === 'issue-operations.setIssueDeleted') deleted = true
    return rpc(action, args)
  }
  const pending = cleanupCase(io.client, io.record, 'cloud', { ...io, timeoutMs: 1000 }).then(() => { settled = true })
  try {
    await Promise.race([io.stopRequested, pending])
    await new Promise(setImmediate)
    assert.equal(io.calls.filter(call => call.action === 'agents.stopRun').length, 1)
    assert.equal(settled, false, 'cloud cleanup must wait for the actual continuation terminal push')
    assert.equal(deleted, false)
    assert.deepEqual(endTargets, [], 'the old ended row cannot stand in for its still-active continuation')
    io.finishChild()
    await pending
    assert.deepEqual(endTargets, [io.root, io.child])
    assert.equal(machineLive, false)
    assert.equal(io.record.cleanup.status, 'passed')
    assert.deepEqual(io.record.cleanup.machines.map(({ runId, outcome, state }) => ({ runId, outcome, state })),
      [io.root, io.child].map(runId => ({ runId, outcome: 'ended', state: 'ended' })))
    assert.equal(io.record.cleanup.machineViews.at(-1).state, 'ended')
    assert.equal(deleted, true)
  } finally { io.finishChild(); await pending }
})

test('cloud cleanup retains the issue when owner end fails after the DB row was marked ended', async () => {
  const runId = id(820), issueId = id(821), calls = []
  const record = { runId, issueId, title: '测试 1505 provider end failure' }
  const client = {
    async json(path, init) {
      if (path === `/api/factory/tasks?issueId=${issueId}`) return { issueId, tasks: [] }
      assert.equal(path, `/api/threads/${runId}/machine`)
      assert.equal(JSON.parse(init.body).action, 'end')
      throw new Error('startup_http_503')
    },
    async rpc(action, args) {
      calls.push({ action, args })
      if (action === 'agents.getIssueThread') return { thread: { id: runId, status: 'failed',
        latestRunId: runId, attempts: [{ runId, status: 'failed' }] } }
      if (action === 'agents.getThreadMachine') return { kind: 'cloud', state: 'error',
        cloud: { sandboxId: 'fixture-retained-vm', template: 'fixture' } }
      if (action === 'issues.getIssue') return { issue: { id: issueId, title: record.title, revision: 2 } }
      assert.equal(action, 'issue-operations.setIssueDeleted')
    },
  }
  await cleanupCase(client, record, 'cloud')
  assert.equal(record.cleanup.status, 'failed')
  assert.equal(calls.some(call => call.action === 'issue-operations.setIssueDeleted'), false,
    'a failed provider retirement must keep the normal recovery entry accessible')
  assert.deepEqual(record.cleanup.retainedFixture, { issueId, runIds: [runId] })
  assert.ok(record.cleanup.errors.some(error => error.step === `machineEnded_${runId}` && error.code === 'startup_http_503'))
})

test('cloud cleanup does not equate end acknowledgements with a still-retained current VM', async () => {
  const io = continuationCleanupFixture(), json = io.client.json.bind(io.client), rpc = io.client.rpc.bind(io.client)
  io.finishChild()
  io.client.json = async (path, init) => path.endsWith('/machine')
    ? { runId: path.split('/')[3], state: 'ended' } : json(path, init)
  io.client.rpc = async (action, args) => action === 'agents.getThreadMachine'
    ? { kind: 'cloud', state: 'error', cloud: { sandboxId: 'PRIVATE_RETAINED_VM', template: 'fixture' } } : rpc(action, args)
  await cleanupCase(io.client, io.record, 'cloud', io)
  assert.equal(io.record.cleanup.status, 'failed')
  assert.deepEqual(io.record.cleanup.errors, [{ step: `machineVerified_${io.root}`, code: 'startup_cleanup_machine_unconfirmed' }])
  assert.deepEqual(io.record.cleanup.retainedFixture, { issueId: io.record.issueId, runIds: [io.root, io.child] })
  assert.equal(io.calls.some(call => call.action === 'issue-operations.setIssueDeleted'), false)
  assert.equal(io.record.cleanup.machineViews[0].state, 'error')
  assert.match(io.record.cleanup.machineViews[0].sandboxIdHash, /^[a-f0-9]{16}$/)
  assert.doesNotMatch(JSON.stringify(io.record.cleanup), /PRIVATE_/)
})

test('cleanup retains its fixture when Factory cancellation loses its revision fence', async () => {
  const runId = id(80), issueId = id(81), taskId = id(82)
  const record = { runId, issueId, title: '测试 1505 failed Factory cancellation' }
  let deleted = false
  const client = {
    async json(path, init) {
      if (path === `/api/factory/tasks?issueId=${issueId}`) return { issueId, tasks: [{ id: taskId, issueId }] }
      assert.equal(path, `/api/factory/tasks/${taskId}`)
      if (!init) return { task: { id: taskId, issueId, status: 'running', revision: 5 }, attempts: [{ runId }] }
      const body = JSON.parse(init.body)
      assert.deepEqual(body.binding, { taskId, revision: 5 })
      assert.equal(body.action, 'cancel')
      throw new Error('startup_http_409')
    },
    async rpc(action, args) {
      if (action === 'agents.getIssueThread') { assert.deepEqual(args, [issueId, runId]); return { thread: { id: runId, status: 'failed', latestRunId: runId, attempts: [{ runId, status: 'failed' }] } } }
      if (action === 'issues.getIssue') return { issue: { id: issueId, title: record.title, revision: 2 } }
      assert.equal(action, 'issue-operations.setIssueDeleted')
      deleted = true
    },
  }
  await cleanupCase(client, record, 'device')
  assert.equal(deleted, false, 'a producer that could still create an attempt must keep its issue recoverable')
  assert.equal(record.cleanup.status, 'failed')
  assert.deepEqual(record.cleanup.errors, [{ step: 'factoryCancelled', code: 'startup_http_409' }])
  assert.deepEqual(record.cleanup.retainedFixture, { issueId, runIds: [runId] })
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


test('reused Coordinator workflow aligns only through the owned run server interval', () => {
  const hashes = ['a'.repeat(16), 'b'.repeat(16)]
  const report = { mode:'baseline', maxStartupMs:5000, cleanup:{errors:[]}, samples: hashes.map((runIdHash,index)=>({
    workflowRunId:'wrun_SHARED', runIdHash, status:'execution_proved_awaiting_server_timing', execution:{credentialType:'subscription'},
    cleanup:{status:'passed'}, agentStart:{storedAt:new Date(epoch+index*10000+3500).toISOString()},
    firstProviderChunk:{storedAt:new Date(epoch+index*10000+5000).toISOString()}})) }
  const logs = hashes.flatMap((runIdHash,index)=>[
    {msg:'dispatch_timing',workflowRunId:'wrun_SHARED',stepId:`step_${index}`,startedAt:epoch+index*10000,endedAt:epoch+index*10000+3000,totalMs:3000,failed:false},
    {msg:'cloud_startup_timing',runIdHash,stage:'cloud.thread.ensure',startedAt:epoch+index*10000+200,endedAt:epoch+index*10000+2900,ms:2700}])
  const aligned = alignServerTimings(report,logs)
  assert.equal(aligned.status,'baseline_recorded')
  assert.deepEqual(aligned.samples.map(sample=>sample.timing.dispatchToAgentStartMs),[3500,3500])
  assert.deepEqual(aligned.samples.map(sample=>sample.timing.stepId),['step_0','step_1'])
})


test('Claude initialization is retained as history but never proves current task acceptance', () => {
  const value = runtimeTiming({runId:id(200),harness:'claude_code'})
  value.agentAccepted.kind = 'claude_system_init'
  const parsed = readRuntimeTiming(value,{runIdHash:value.runIdHash,harness:'claude_code'})
  assert.equal(parsed.agentAccepted.kind,'claude_system_init')
  assert.deepEqual(runtimeEvidence(parsed),{status:'unavailable',reason:'official_agent_acceptance_missing',allFirstPartyHttpComplete:false})
  value.agentAccepted.kind = 'claude_user_ack'
  assert.equal(runtimeEvidence(readRuntimeTiming(value,{runIdHash:value.runIdHash,harness:'claude_code'})).status,'passed')
})

test('a fast legacy dispatch body cannot pass the full dispatch-entry acceptance gate', () => {
  const make = () => ({ mode: 'acceptance', target: 'cloud', maxStartupMs: 5000, cleanup: { errors: [] },
    samples: [0, 1, 2].map(n => ({ workflowRunId: `wrun_${n}`, execution: { credentialType: 'subscription' }, cleanup: { status: 'passed' },
      runtimeTiming: runtimeTiming({ runId: id(800 + n), harness: 'claude_code' }),
      agentStart: { storedAt: new Date(epoch + 3500).toISOString() }, firstProviderChunk: { storedAt: new Date(epoch + 4000).toISOString() } })) })
  const logs = [0, 1, 2].map(n => ({ msg: 'dispatch_timing', workflowRunId: `wrun_${n}`, startedAt: epoch, endedAt: epoch + 2000,
    totalMs: 2000, failed: false }))
  const legacy = alignServerTimings(make(), logs)
  assert.equal(legacy.status, 'failed')
  assert.equal(legacy.samples[0].timing.dispatchBoundary, 'legacy_dispatch_body')
  assert.equal(legacy.samples[0].timing.dispatchToAgentStartMs, 3500)
  assert.equal(legacy.samples[0].timing.withinTarget, false)
  const entryLogs = logs.map(log => ({ ...log, boundary: 'dispatch_run_entry' }))
  assert.equal(alignServerTimings(make(), entryLogs).status, 'passed')
  const unaccepted = make()
  unaccepted.samples[0].runtimeTiming.agentAccepted.kind = 'claude_system_init'
  assert.equal(alignServerTimings(unaccepted, entryLogs).status, 'failed')
})

test('remote authorization after the actual task ACK cannot hide in the preparing phase', () => {
  const value = runtimeTiming({ runId: id(900), harness: 'claude_code' })
  value.executionStartMs = 3500
  value.agentAccepted.ms = 2500
  value.requests[0].endpoint = 'permission_check'
  value.requests[0].phase = 'preparing'
  value.counts[0].endpoint = 'permission_check'
  value.counts[0].phase = 'preparing'
  const result = runtimeEvidence(readRuntimeTiming(value, { runIdHash: value.runIdHash, harness: value.harness }))
  assert.equal(result.status, 'failed')
  assert.equal(result.extraRemoteCalls, 1)
  value.agentAccepted.ms = 3200
  assert.equal(runtimeEvidence(readRuntimeTiming(value, { runIdHash: value.runIdHash, harness: value.harness })).status, 'passed')
})
