#!/usr/bin/env node
/** #1505: real, normal-session repository dispatch. No provider tokens or DB access.
 *
 * ACME_DEMO_EMAIL / ACME_DEMO_PASSWORD come from the existing prod:/ identity.
 * The Coordinator is the public repository-dispatch entry. Its tool stream has
 * no server timestamp (tool.at is a text offset), so a live report deliberately
 * remains unaligned until the operator supplies the matching dispatch_timing
 * log. --align-report performs that final, entirely offline step.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeTiming, runtimeEvidence } from './cloud-startup-evidence.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODELS = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const ROUTES = { claude_code: 'claude_code_cli', codex: 'codex_cli' }
const REPOSITORY = 'alexj11324/Mikka-handoff'
const TERMINAL = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled'])
// Kept closed like the daemon collector: never copy arbitrary chunk fields.
const STARTUP_PHASES = new Set(['daemon.adapter.model_report', 'daemon.adapter.auth', 'daemon.adapter.auth.gate',
  'daemon.adapter.auth.context', 'daemon.adapter.auth.access', 'daemon.adapter.auth.token', 'daemon.adapter.auth.native_auth',
  'daemon.adapter.auth.refresh', 'daemon.adapter.auth.broker', 'daemon.adapter.workspace.shadow_clone', 'daemon.adapter.workspace.read_tree',
  'daemon.adapter.cli_init', 'daemon.adapter.account_check', 'daemon.adapter.account_check.account_info', 'daemon.adapter.account_check.login'])
const sha = value => createHash('sha256').update(value).digest('hex')
const fail = (code, cause) => { throw new Error(`startup_${code}`, cause ? { cause } : undefined) }
const safeError = error => /^startup_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'startup_failed'
const assert = (condition, code) => { if (!condition) fail(code) }
const iso = value => new Date(value).toISOString()
const dateValue = value => typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** The transport's actual tagged Date/undefined codec, without server imports. */
export function decodeWire(value) {
  if (Array.isArray(value)) return value.map(decodeWire)
  if (!value || typeof value !== 'object') return value
  if (value.$mikka === 'date') return value.value
  if (value.$mikka === 'undefined') return undefined
  if (value.$mikka === 'object') return Object.fromEntries(value.value.map(([key, item]) => [key, decodeWire(item)]))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeWire(item)]))
}

/** Fixed high half, random low half with a small XOR: accepted by the current
 * TraceIdRatioBasedSampler(0.1), without altering any production sampling rate.
 * The workflow may create its own trace; report these as request trace IDs only. */
export function sampledRequestTrace() {
  const a = randomBytes(4).readUInt32BE(), small = randomBytes(4).readUInt32BE() & 0x0fffffff
  const b = (a ^ small) >>> 0
  const traceId = `0000000000000000${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
  const parentId = randomBytes(8).toString('hex')
  return { traceId, traceparent: `00-${traceId}-${parentId}-01` }
}

export function parseOptions(args, env = process.env) {
  const options = { origin: env.MIKKA_ACCEPTANCE_BASE_URL ?? 'https://app.aspectlylabs.com',
    workspace: env.MIKKA_ACCEPTANCE_WORKSPACE_ID, runs: 3, harness: 'both', mode: 'baseline',
    strategy: 'official', maxStartupMs: 5000, timeoutMs: 240000, expectedBuild: env.MIKKA_EXPECTED_BUILD,
    revision: env.MIKKA_EXPECTED_DEPLOYMENT_SHA, expectedWorkerSha: env.MIKKA_EXPECTED_WORKER_SHA,
    expectedWorkerSource: env.MIKKA_EXPECTED_WORKER_SOURCE, output: '.cache/acceptance/cloud-startup.json' }
  const names = { origin: 'origin', workspace: 'workspace', runs: 'runs', harness: 'harness', mode: 'mode', strategy: 'strategy',
    'max-startup-ms': 'maxStartupMs', 'timeout-ms': 'timeoutMs', 'expected-build': 'expectedBuild', revision: 'revision', output: 'output',
    'device-id': 'deviceId', 'agent-id': 'agentId', 'bot-id': 'botId', 'align-report': 'alignReport', 'dispatch-timings': 'dispatchTimings',
    'expected-worker-sha': 'expectedWorkerSha', 'expected-worker-source': 'expectedWorkerSource',
    'runtime-evidence': 'runtimeEvidence', 'official-timing': 'officialTiming' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true }
    const key = names[args[i].replace(/^--/, '')]
    assert(args[i].startsWith('--') && key && args[i + 1] && !args[i + 1].startsWith('--'), 'option_invalid')
    options[key] = args[++i]
  }
  if (options.alignReport) { assert(options.dispatchTimings, 'dispatch_timings_required'); return options }
  for (const key of ['runs', 'maxStartupMs', 'timeoutMs']) options[key] = Number(options[key])
  assert(UUID.test(options.workspace ?? ''), 'workspace_required')
  assert(['both', 'claude_code', 'codex'].includes(options.harness), 'harness_invalid')
  assert(['baseline', 'acceptance', 'candidate'].includes(options.mode), 'mode_invalid')
  options.runtimeEvidence ??= options.mode === 'acceptance' ? 'required' : 'optional'
  options.officialTiming ??= options.mode === 'acceptance' ? 'enabled' : 'disabled'
  assert(['required', 'optional'].includes(options.runtimeEvidence), 'runtime_evidence_invalid')
  assert(['enabled', 'disabled'].includes(options.officialTiming), 'official_timing_invalid')
  assert(options.officialTiming !== 'enabled' || options.runtimeEvidence === 'required', 'runtime_evidence_required')
  assert(['official', 'derived', 'pool', 'combined'].includes(options.strategy), 'strategy_invalid')
  assert(Number.isInteger(options.runs) && options.runs >= (options.mode === 'candidate' ? 1 : 3) && options.runs <= 20, 'runs_invalid')
  assert(Number.isSafeInteger(options.maxStartupMs) && options.maxStartupMs > 0 && options.maxStartupMs <= 60000, 'threshold_invalid')
  assert(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 600000, 'timeout_invalid')
  assert(!options.botId || UUID.test(options.botId), 'bot_invalid')
  assert((!options.deviceId && !options.agentId) || (UUID.test(options.deviceId ?? '') && UUID.test(options.agentId ?? '')
    && options.harness !== 'both' && options.mode === 'candidate'), 'candidate_target_invalid')
  const target = new URL(options.origin)
  assert(!target.username && !target.password && !target.search && !target.hash && ['/', '/mikka', '/mikka/'].includes(target.pathname), 'origin_invalid')
  assert(target.protocol === 'https:' || (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)), 'origin_invalid')
  options.origin = target.origin
  assert(options.mode !== 'acceptance' || (options.expectedBuild && /^[a-f0-9]{40}$/.test(options.revision ?? '')), 'version_pin_required')
  assert((!options.expectedWorkerSha && !options.expectedWorkerSource) || (/^[a-f0-9]{40}$/.test(options.expectedWorkerSha ?? '')
    && /^[a-f0-9]{40}$/.test(options.expectedWorkerSource ?? '')), 'worker_pin_invalid')
  return options
}

/** Read only the published runtime's public identifiers, never export the
 * Vercel environment listing or any other key's value. These are configuration
 * pins; actual per-run runtime SHA still comes from the startup log evidence. */
export async function readProductionWorkerRelease({ token, fetchImpl = fetch }) {
  assert(token, 'vercel_token_required')
  const { api, PROJECT } = await import('../e2b/publish-template-env.mjs')
  const { envs } = await api(`/v10/projects/${PROJECT}/env`, { token, fetchImpl })
  const keys = ['MIKKA_CLOUD_WORKER_SHA', 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT', 'E2B_BYO_COMPUTER_TEMPLATE', 'E2B_CLAUDE_TEMPLATE', 'E2B_CODEX_TEMPLATE']
  const values = await Promise.all(keys.map(async key => {
    const rows = (envs ?? []).filter(item => item.key === key && item.target?.includes('production') && !item.gitBranch)
    assert(rows.length === 1, 'worker_configuration_missing')
    const { value } = await api(`/v1/projects/${PROJECT}/env/${encodeURIComponent(rows[0].id)}`, { token, fetchImpl })
    assert(typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value), 'worker_configuration_invalid')
    return value
  }))
  assert(/^[a-f0-9]{40}$/.test(values[0]) && /^[a-f0-9]{40}$/.test(values[1]), 'worker_configuration_invalid')
  return { workerSha: values[0], sourceCommit: values[1], templates: { desktop: values[2], claude: values[3], codex: values[4] } }
}

export function createSessionClient(origin, fetchImpl = fetch) {
  const target = new URL(origin)
  assert(target.origin === origin && !target.username && !target.password && (target.protocol === 'https:'
    || (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))), 'origin_invalid')
  const cookies = new Map()
  async function request(path, init = {}, timeoutMs = 30000) {
    const url = new URL(`/mikka${path}`, origin)
    assert(url.origin === origin && url.pathname.startsWith('/mikka/'), 'foreign_origin')
    let response
    try {
      response = await fetchImpl(url, { ...init, headers: { origin, 'cache-control': 'no-store',
        ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}), ...init.headers },
        redirect: 'error', signal: init.signal ?? AbortSignal.timeout(timeoutMs) })
    } catch (error) { fail('request_failed', error) }
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0], equals = pair.indexOf('=')
      if (equals < 1) continue
      const key = pair.slice(0, equals), value = pair.slice(equals + 1)
      if (!value || /;\s*max-age=0(?:;|$)/i.test(line)) cookies.delete(key)
      else cookies.set(key, value)
    }
    return response
  }
  async function json(path, init, timeoutMs) {
    const response = await request(path, init, timeoutMs)
    let body
    try { body = await response.json() } catch (error) { fail('response_invalid', error) }
    if (!response.ok) fail(`http_${response.status}`)
    assert(!body?.error, 'api_refused')
    return body
  }
  async function rpc(action, args, extra = {}) {
    const response = await json('/api/rpc', { ...post({ version: 1, action, args }), headers: {
      'content-type': 'application/json', 'x-mikka-rpc': '1', ...extra.headers } }, extra.timeoutMs)
    assert(response.ok === true, 'rpc_refused')
    const value = decodeWire(response.result)
    assert(!value?.error && value?.ok !== false, 'action_refused')
    return value?.ok === true && 'data' in value ? value.data : value
  }
  return { request, json, rpc, clear: () => cookies.clear() }
}

function readDispatchOutput(output) {
  if (typeof output !== 'string') return null
  let value
  try { value = JSON.parse(output) } catch { return null }
  if (value?.type === 'json') value = value.value
  return value && UUID.test(value.runId ?? '') ? value : null
}

/** A bounded NDJSON read, never a polling loop. Only safe identifiers/times leave. */
async function dispatchThroughCoordinator(client, record, { botId, profileId, deviceId, agentId, timeoutMs }, now) {
  const marker = `STARTUP_OK_${record.sampleId}`
  const toolInput = { issueId: record.issueId, repo: REPOSITORY, target: deviceId ? { deviceId } : 'cloud', profileId,
    ...(agentId ? { agentId } : {}), readOnly: true,
    note: `Read one line of README (or list the repository root if absent), then reply ${marker}. Do not modify files, create branches, commit, push, open a PR, send messages, or spawn other agents.` }
  const text = `执行已有测试任务 ${record.issueId}，不要创建另一项任务。请调用一次 dispatch_run，参数如下：${JSON.stringify(toolInput)}。使用已固定模型的指定 Profile，不另传 model，不换 Profile、订阅或电脑。派发完成后只汇报 runId。`
  const trace = sampledRequestTrace()
  record.requestTraceId = trace.traceId
  record.requestTraceScope = 'submission_http_only_workflow_may_use_another_trace'
  record.messageSubmittedAt = iso(now())
  await client.rpc('coordinator.sendCoordinatorMessage', [text, null, botId, randomUUID(),
    deviceId ? { kind: 'device', deviceId } : { $mikka: 'undefined' }, null, [], { $mikka: 'undefined' }, profileId],
  { headers: { traceparent: trace.traceparent } })
  const response = await client.request(`/api/coordinator/stream?botId=${botId}&wait=1`, {}, timeoutMs)
  assert(response.status === 200 && response.body && response.headers.get('content-type')?.includes('application/x-ndjson'), 'coordinator_stream_unavailable')
  const workflowRunId = response.headers.get('x-mikka-stream-run')
  assert(/^wrun_[A-Za-z0-9]+$/.test(workflowRunId ?? ''), 'workflow_run_missing')
  record.workflowRunId = workflowRunId
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', selectedCall
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      assert(buffer.length < 1000000, 'coordinator_stream_too_large')
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let event
        try { event = JSON.parse(line) } catch (error) { fail('coordinator_stream_invalid', error) }
        if (event.type !== 'tool' || event.name !== 'dispatch_run') continue
        if (event.state === 'running') {
          // A durable Coordinator workflow can replay earlier chat turns.
          // Bind the call to this owned issue or its unique read-only marker.
          if (!event.quote?.includes(marker) && !event.input?.includes(record.issueId)) continue
          assert(!selectedCall || selectedCall === event.call, 'multiple_dispatches')
          selectedCall = event.call
          record.dispatchCallId = event.call
          record.dispatchObservedAt ??= iso(now())
          continue
        }
        if (!selectedCall || event.call !== selectedCall) continue
        record.dispatchReturnedAt = iso(now())
        if (event.state !== 'done') {
          const code = typeof event.errorCode === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(event.errorCode) ? event.errorCode : 'unavailable'
          record.dispatchRefusal = { code }
          fail('dispatch_refused')
        }
        const result = readDispatchOutput(event.output)
        // The public stream intentionally truncates output at 200 characters.
        // Resolve the one thread of our newly-created issue after its push;
        // this is one event-triggered read, not a background polling loop.
        const { threads } = await client.rpc('agents.pollIssueThreads', [record.issueId])
        assert(Array.isArray(threads) && threads.length === 1 && UUID.test(threads[0].id ?? '')
          && threads[0].ownedByCurrentUser === true, 'dispatch_run_missing')
        if (result) {
          assert(result.thread === 'new' && result.runId === threads[0].id, 'dispatch_not_new')
          assert(deviceId ? result.placement?.kind === 'device' && result.placement.deviceId === deviceId
            : result.placement?.kind === 'cloud', 'placement_mismatch')
        }
        record.runId = threads[0].id
        record.runIdHash = sha(record.runId).slice(0, 16)
        record.placement = deviceId ? { kind: 'device', deviceId } : { kind: 'cloud' }
        return
      }
      if (done) fail('dispatch_not_observed')
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function readStartupTiming(value, record) {
  const duration = number => Number.isFinite(number) && number >= 0 && number <= 3_600_000
  const outcome = text => text === 'ok' || text === 'error'
  if (value?.version !== 1 || !/^[a-f0-9]{16}$/.test(value.runIdHash ?? '') || value.runIdHash !== record.runIdHash
    || value.harness !== record.harness || !Object.hasOwn(MODELS, value.harness) || !outcome(value.outcome)
    || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0 || !Number.isSafeInteger(value.endedAt) || value.endedAt < value.startedAt
    || !duration(value.ms) || typeof value.truncated !== 'boolean' || !Array.isArray(value.phases) || value.phases.length > 64) return null
  const phases = []
  for (const phase of value.phases) {
    if (!STARTUP_PHASES.has(phase?.name) || !outcome(phase.outcome) || !duration(phase.ms) || !duration(phase.startMs)
      || !duration(phase.endMs) || phase.endMs < phase.startMs || phase.endMs > value.ms + 0.01
      || Math.abs(phase.ms - (phase.endMs - phase.startMs)) > 0.01) return null
    phases.push({ name: phase.name, startMs: phase.startMs, endMs: phase.endMs, ms: phase.ms, outcome: phase.outcome })
  }
  return { version: 1, runIdHash: value.runIdHash, harness: value.harness, startedAt: value.startedAt, endedAt: value.endedAt,
    ms: value.ms, outcome: value.outcome, phases, truncated: value.truncated }
}

/** Only post-start provider output counts. Stage/usage/state/status and a bare
 * message boundary are daemon activity, not evidence of model execution. */
export function observeChunks(record, detail, observedAt) {
  const stages = record.stages ??= []
  const toolCalls = record.toolCalls ??= []
  // getIssueThread replays the stream. Derive ordering afresh from this read,
  // never from toolCalls retained by an earlier read of the same chunks.
  const toolInputs = new Set()
  let started = false, reply = '', completedTool = false, replyAfterTool = '', replyVerifiedAfterTool = false
  for (const item of detail.chunks ?? []) {
    const { chunk } = item
    const at = dateValue(item.at)
    if (chunk?.type === 'finish' && chunk.messageMetadata?.mikkaRuntimeTiming !== undefined) {
      const timing = readRuntimeTiming(chunk.messageMetadata.mikkaRuntimeTiming, record)
      if (timing) record.runtimeTiming ??= timing
      if (timing?.agentAccepted) record.agentAccepted ??= { ...timing.agentAccepted, clock: 'daemon_wall_and_monotonic' }
      record.runtimeTimingStatus = record.runtimeTiming ? (record.runtimeTiming.truncated ? 'truncated' : record.runtimeTiming.complete ? 'complete' : 'incomplete') : 'invalid'
      if (record.runtimeTiming) record.runtimeEvidence = runtimeEvidence(record.runtimeTiming, { requireOfficial: record.requireOfficialTiming })
    }
    if (chunk?.type === 'data-run-stage') {
      const data = chunk.data
      if (['repository', 'worktree', 'agent_start'].includes(data?.stage) && Number.isFinite(data.ms) && typeof data.ok === 'boolean') {
        if (!stages.some(stage => stage.stage === data.stage)) stages.push({ stage: data.stage, ms: data.ms, ok: data.ok,
          ...(Number.isFinite(at) ? { storedAt: iso(at) } : {}) })
        if (data.stage === 'agent_start') {
          const timing = readStartupTiming(data.startupTiming, record)
          if (timing) record.daemonStartupTiming ??= timing
          record.startupTimingStatus = record.daemonStartupTiming ? (record.daemonStartupTiming.truncated ? 'truncated' : 'complete')
            : data.startupTiming === undefined ? 'unavailable' : 'invalid'
        }
        if (data.stage === 'agent_start' && data.ok) {
          started = true
          record.agentStart ??= { storedAt: Number.isFinite(at) ? iso(at) : null, observedAt: iso(observedAt) }
        }
      }
    } else if (started) {
      if (['tool-input-start', 'tool-input-available', 'tool-output-available', 'tool-output-error'].includes(chunk?.type)
        && typeof chunk.toolCallId === 'string' && chunk.toolCallId.length > 0 && chunk.toolCallId.length <= 512) {
        const toolCallHash = sha(chunk.toolCallId).slice(0, 16)
        if (chunk.type.startsWith('tool-input-') && toolInputs.size < 64) toolInputs.add(toolCallHash)
        if (chunk.type === 'tool-output-available' && toolInputs.has(toolCallHash)) completedTool = true
        let tool = toolCalls.find(call => call.toolCallHash === toolCallHash)
        if (!tool && chunk.type.startsWith('tool-input-') && toolCalls.length < 64) {
          tool = { toolCallHash, startedAt: Number.isFinite(at) ? iso(at) : null, outcome: 'pending' }; toolCalls.push(tool)
        }
        if (tool && chunk.type.startsWith('tool-output-')) {
          tool.completedAt = Number.isFinite(at) ? iso(at) : null
          tool.outcome = chunk.type === 'tool-output-error' ? 'error' : 'ok'
        }
      }
      const output = ['text-delta', 'reasoning-delta'].includes(chunk?.type) ? chunk.delta : undefined
      if (!record.firstProviderChunk && ((typeof output === 'string' && output.length > 0)
        || ['tool-input-start', 'tool-input-available'].includes(chunk?.type))) {
        record.firstProviderChunk = { type: chunk.type, storedAt: Number.isFinite(at) ? iso(at) : null, observedAt: iso(observedAt),
          ...(typeof output === 'string' ? { bytes: Buffer.byteLength(output), sha256: sha(output) } : {}) }
      }
      if (chunk?.type === 'text-delta' && typeof output === 'string') {
        reply += output
        if (reply.includes(`STARTUP_OK_${record.sampleId}`)) record.replyVerified = true
        reply = reply.slice(-256)
        if (completedTool) {
          replyAfterTool += output
          if (replyAfterTool.includes(`STARTUP_OK_${record.sampleId}`)) replyVerifiedAfterTool = true
          replyAfterTool = replyAfterTool.slice(-256)
        }
      }
    }
  }
  record.replyVerifiedAfterTool = replyVerifiedAfterTool
  record.lastStatus = typeof detail.thread?.status === 'string' && /^[a-z_]+$/.test(detail.thread.status) ? detail.thread.status : null
  return Boolean(record.agentStart && record.firstProviderChunk && (!record.requireReply || record.replyVerified)
    && toolCalls.filter(tool => tool.outcome === 'ok').length >= (record.minToolCalls ?? 0)
    && (!record.requireReplyAfterTool || record.replyVerifiedAfterTool)
    && (!record.requireRuntimeReceipt || record.runtimeTimingStatus === 'complete')
    && (!record.requireTerminal || (detail.thread?.id === record.runId && TERMINAL.has(record.lastStatus))))
}

/** The public detail keeps the original run's status separate from later
 * attempts. Only this server-resolved chain can supply cleanup targets. */
function cleanupAttempts(detail, runId) {
  const attempts = detail.thread?.attempts
  assert(detail.thread?.id === runId && Array.isArray(attempts) && attempts.length > 0
    && attempts.every(attempt => UUID.test(attempt?.runId ?? '') && typeof attempt.status === 'string')
    && new Set(attempts.map(attempt => attempt.runId)).size === attempts.length
    && attempts.some(attempt => attempt.runId === runId), 'cleanup_scope_mismatch')
  return attempts
}

/** One live owner channel per server-reported scope. Reads happen on pushes,
 * once on connection (to cover the opening race), and once at the deadline. */
async function watchRun(client, record, timeoutMs, WebSocketImpl, now, cleanupRunIds) {
  const sockets = new Map(), timers = new Set()
  const watchedRunIds = new Set([record.runId])
  let closed = false, reading = false, dirty = false, settle
  const outcome = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const observed = detail => {
    if (!cleanupRunIds) return observeChunks(record, detail, now())
    const attempts = cleanupAttempts(detail, record.runId)
    for (const attempt of attempts) { cleanupRunIds.add(attempt.runId); watchedRunIds.add(attempt.runId) }
    return attempts.every(attempt => TERMINAL.has(attempt.status))
  }
  const later = (work, ms) => { const timer = setTimeout(() => { timers.delete(timer); work() }, ms); timers.add(timer); return timer }
  const reject = error => { if (!closed) settle.reject(error) }
  const kick = () => {
    if (closed) return
    dirty = true
    if (!reading) void refresh().catch(reject)
  }
  async function connect(workspaceId) {
    if (sockets.has(workspaceId)) return
    const ticket = await client.json(`/api/live/ticket?workspace=${workspaceId}`)
    const url = new URL(ticket.url)
    assert(['wss:', 'ws:'].includes(url.protocol) && !url.username && !url.password && typeof ticket.protocol === 'string'
      && Number.isFinite(ticket.expiresAt) && ticket.expiresAt > now(), 'live_ticket_invalid')
    assert(url.protocol === 'wss:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'live_origin_invalid')
    url.searchParams.set('revisions', '1')
    const socket = new WebSocketImpl(url, ticket.protocol)
    sockets.set(workspaceId, socket)
    socket.onclose = socket.onerror = () => { if (!closed) failLive('live_disconnected') }
    const failLive = code => reject(new Error(`startup_${code}`))
    socket.onmessage = message => {
      if (closed || message.data === 'pong' || typeof message.data !== 'string' || message.data.length > 2048) return
      let value
      try { value = JSON.parse(message.data) } catch { return }
      if (value.type === 'live_ready') {
        if (!Array.isArray(value.kinds) || !value.kinds.includes('thread') || !value.kinds.includes('run')) return failLive('live_capability_missing')
        kick(); return
      }
      if ((['thread', 'run'].includes(value.kind) && watchedRunIds.has(value.id))
        || (value.kind === 'issue_threads' && value.id === record.issueId)) kick()
    }
    socket.onopen = () => {
      const heartbeat = () => { if (closed) return; if (socket.readyState === 1) socket.send('ping'); later(heartbeat, 30000) }
      later(heartbeat, 30000)
    }
    later(() => { if (!closed) failLive('live_ticket_expired') }, Math.max(1, ticket.expiresAt - now()))
  }
  async function refresh() {
    reading = true
    try {
      do {
        dirty = false
        const detail = await client.rpc('agents.getIssueThread', [record.issueId, record.runId])
        record.detailReads = (record.detailReads ?? 0) + 1
        record.runCreatedAt ??= detail.thread?.createdAt ?? null
        if (observed(detail)) { settle.resolve(); return }
        if (!cleanupRunIds && TERMINAL.has(record.lastStatus)) fail('ended_before_execution_proof')
        const scopes = [...new Set((detail.live?.runs ?? []).filter(run => watchedRunIds.has(run.id)).map(run => run.workspaceId))]
        assert(scopes.length && scopes.every(id => UUID.test(id ?? '')), 'live_scope_missing')
        for (const scope of scopes) await connect(scope)
      } while (dirty && !closed)
    } finally { reading = false }
  }
  later(() => {
    void client.rpc('agents.getIssueThread', [record.issueId, record.runId]).then(detail => {
      if (observed(detail)) settle.resolve()
      else fail(cleanupRunIds ? 'cleanup_terminal_timeout' : 'execution_timeout')
    }).catch(reject)
  }, timeoutMs)
  kick()
  try { await outcome }
  finally {
    closed = true
    for (const timer of timers) clearTimeout(timer)
    for (const socket of sockets.values()) { socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null; socket.close() }
  }
}

function safeIdentity(identity) {
  if (!identity || identity.version !== 1) return null
  return { version: 1, requesterHash: sha(String(identity.requester)).slice(0, 16),
    executionPrincipalHash: sha(String(identity.executionPrincipal)).slice(0, 16),
    model: identity.billingAccount?.model?.kind ?? null, runtime: identity.billingAccount?.runtime?.kind ?? null,
    subscriptionAccess: identity.resourceBindings?.filter(resource => resource.kind === 'subscription').map(resource => resource.access) ?? [] }
}

async function subscriptionProof(client, record) {
  const evidence = await client.json(`/api/runs/${record.runId}/evidence`), run = evidence.run
  assert(run?.id === record.runId && run.issueId === record.issueId && run.harness === record.harness
    && run.model === MODELS[record.harness] && run.credentialType === 'subscription'
    && run.subscriptionRoute === ROUTES[record.harness] && run.agentProfile?.profileId === record.profileId,
  'subscription_provenance_mismatch')
  const identity = run.executionIdentity
  const device = identity?.resourceBindings?.find(resource => resource.kind === 'device')
  assert(UUID.test(device?.id ?? '') && identity.billingAccount?.model?.kind === 'subscription'
    && (record.placement.kind === 'cloud' ? identity.billingAccount?.runtime?.kind === 'e2b'
      : device.id === record.placement.deviceId), 'execution_device_mismatch')
  record.execution = { harness: run.harness, model: run.model, credentialType: run.credentialType,
    deviceId: device.id, subscriptionRoute: run.subscriptionRoute, identity: safeIdentity(identity) }
}

export async function cleanupCase(client, record, target, { timeoutMs = 60000, WebSocketImpl = globalThis.WebSocket, now = Date.now } = {}) {
  const cleanup = record.cleanup ??= { status: 'running', errors: [] }
  const runIds = new Set(record.runId ? [record.runId] : [])
  let runsEnded = true
  const step = async (name, operation) => {
    try { await operation(); cleanup[name] = true; return true }
    catch (error) { cleanup.errors.push({ step: name, code: safeError(error) }); return false }
  }
  if (record.issueId) await step('factoryCancelled', async () => {
    const listing = await client.json(`/api/factory/tasks?issueId=${record.issueId}`)
    assert(listing.issueId === record.issueId && Array.isArray(listing.tasks), 'factory_list_invalid')
    for (const item of listing.tasks) {
      assert(item.issueId === record.issueId && UUID.test(item.id), 'cleanup_scope_mismatch')
      const snapshot = await client.json(`/api/factory/tasks/${item.id}`)
      assert(snapshot.task?.issueId === record.issueId, 'cleanup_scope_mismatch')
      for (const attempt of snapshot.attempts ?? []) if (UUID.test(attempt.runId ?? '')) runIds.add(attempt.runId)
      if (!['passed', 'cancelled', 'revoked'].includes(snapshot.task.status)) await client.json(`/api/factory/tasks/${item.id}`, post({
        binding: { taskId: item.id, revision: snapshot.task.revision }, eventId: randomUUID(), action: 'cancel', reason: '测试 1505 startup measurement complete; stop only this test task.' }))
    }
  })
  // A normal stop on the original run also stops its later attempts. Keep any
  // discovered child IDs for failure recovery without issuing duplicate stops.
  const initialRunIds = [...runIds]
  for (const runId of initialRunIds) {
    const stopped = await step(`runStopped_${runId}`, async () => {
      const ended = detail => {
        if (target !== 'device') return TERMINAL.has(detail.thread?.status)
        const attempts = cleanupAttempts(detail, runId)
        for (const attempt of attempts) runIds.add(attempt.runId)
        return attempts.every(attempt => TERMINAL.has(attempt.status))
      }
      const detail = await client.rpc('agents.getIssueThread', [record.issueId, runId])
      if (ended(detail)) return
      try { await client.rpc('agents.stopRun', [runId]) }
      catch (error) {
        // Completion racing a stop legitimately returns runChainEnded (409).
        // Confirm the owned run ended; never swallow an unrelated stop error.
        const latest = await client.rpc('agents.getIssueThread', [record.issueId, runId])
        if (!ended(latest)) throw error
        return
      }
      // A local device cannot be removed while any run is live. An accepted
      // stop only records stopRequestedAt; wait for the daemon's real terminal
      // update using the same owner live channel as execution observation.
      if (target === 'device') await watchRun(client, { issueId: record.issueId, runId },
        Math.min(timeoutMs, 60000), WebSocketImpl, now, runIds)
    })
    if (target === 'device' && !stopped) runsEnded = false
    if (target === 'cloud') await step(`machineEnded_${runId}`, () => client.json(`/api/threads/${runId}/machine`, post({ action: 'end' }), 120000))
  }
  if (record.issueId && runsEnded) await step('taskDeleted', async () => {
    const { issue } = await client.rpc('issues.getIssue', [record.issueId])
    assert(issue?.id === record.issueId && issue.title === record.title, 'cleanup_scope_mismatch')
    await client.rpc('issue-operations.setIssueDeleted', [{ id: issue.id, revision: issue.revision }])
  })
  if (!runsEnded) cleanup.retainedFixture = { issueId: record.issueId, runIds: [...runIds] }
  cleanup.status = cleanup.errors.length ? 'failed' : 'passed'
}

/** One owned repository task, for the candidate-template CI gate as well as the
 * production measurement. The caller supplies a normal authenticated client
 * {request, json, rpc}, a dedicated test Bot and an authorized fixed Profile.
 * Profiles, account sessions and candidate devices remain the caller's scope.
 * Returns sanitized evidence even on failure, after cleaning only this issue. */
export async function runSubscriptionCase({ client, botId, profileId, harness, model = MODELS[harness],
  deviceId, agentId, sourceCommit, expectedBuild, repository = REPOSITORY, titlePrefix = '测试 1505',
  sampleId = randomUUID(), timeoutMs = 240000, requireReply = true, minToolCalls = deviceId ? 0 : 1,
  runtimeEvidence: runtimeEvidenceMode = 'optional', officialTiming = 'disabled',
  now = Date.now, WebSocketImpl = globalThis.WebSocket, pinBuild }) {
  assert(client && ['request', 'json', 'rpc'].every(key => typeof client[key] === 'function'), 'client_required')
  assert(UUID.test(botId ?? '') && UUID.test(profileId ?? ''), 'fixture_required')
  assert(Object.hasOwn(MODELS, harness) && model === MODELS[harness], 'model_invalid')
  assert(repository === REPOSITORY && titlePrefix.includes('测试') && titlePrefix.length <= 80, 'fixture_scope_invalid')
  assert(/^[A-Za-z0-9_-]{1,80}$/.test(sampleId), 'sample_id_invalid')
  assert((!deviceId && !agentId) || (UUID.test(deviceId ?? '') && UUID.test(agentId ?? '')), 'candidate_target_invalid')
  const record = { sampleId, harness, requestedModel: model, title: `${titlePrefix} ${sampleId} ${harness}`,
    profileId, requireReply, minToolCalls, requireRuntimeReceipt: runtimeEvidenceMode === 'required' || Boolean(deviceId), requireAgentAcceptance: Boolean(deviceId), requireTerminal: Boolean(deviceId), requireOfficialTiming: officialTiming === 'enabled',
    requireReplyAfterTool: minToolCalls > 0 && (Boolean(deviceId) || runtimeEvidenceMode === 'required'),
    stages: [], status: 'running', ...(sourceCommit ? { sourceCommit } : {}) }
  const pin = pinBuild ?? (async () => {
    const { build } = await client.json('/api/version')
    assert(typeof build === 'string' && (!expectedBuild || build === expectedBuild), 'build_mismatch')
    assert(!record.build || build === record.build, 'build_changed'); record.build = build
  })
  try {
    await pin()
    const identity = await client.json('/api/auth/get-session')
    assert(identity.user?.email?.toLowerCase() === 'alex@acme.aspectlylabs.com', 'session_identity_mismatch')
    const bot = await client.json(`/api/bots/${botId}`)
    assert(bot.id === botId && /^测试\s*1505(?:\s|$)/.test(bot.name ?? ''), 'test_bot_required')
    const created = await client.rpc('issues.saveIssue', [{ title: record.title, status: 'todo', priority: 'low', content: {
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Read one line of README in ${REPOSITORY} and reply STARTUP_OK_${sampleId}. Read only; no files, branches, commits, PRs, external messages, or additional agents.` }] }],
    } }])
    assert(UUID.test(created.issue?.id ?? ''), 'issue_create_failed'); record.issueId = created.issue.id
    await dispatchThroughCoordinator(client, record, { botId, profileId, deviceId, agentId, timeoutMs }, now)
    await client.rpc('coordinator.stopCoordinatorTurn', [botId])
    record.coordinatorStopped = true
    await subscriptionProof(client, record)
    await watchRun(client, record, timeoutMs, WebSocketImpl, now)
    await subscriptionProof(client, record)
    await pin()
    if (runtimeEvidenceMode === 'required') assert(record.runtimeEvidence?.status === 'passed', 'runtime_evidence_failed')
    if (record.requireAgentAcceptance) assert(record.runtimeTiming?.agentAccepted?.kind === (harness === 'claude_code' ? 'claude_user_ack' : 'codex_turn_start_ack'), 'official_agent_acceptance_missing')
    if (!deviceId) assert(record.startupTimingStatus === 'complete' && record.daemonStartupTiming?.outcome === 'ok'
      && record.daemonStartupTiming.phases.some(phase => phase.name === 'daemon.adapter.cli_init'), 'daemon_startup_timing_incomplete')
    record.observed = { messageToAgentStartMs: dateValue(record.agentStart.observedAt) - dateValue(record.messageSubmittedAt),
      toolObservedToAgentStartMs: dateValue(record.agentStart.observedAt) - dateValue(record.dispatchObservedAt),
      toolObservedToFirstProviderMs: dateValue(record.firstProviderChunk.observedAt) - dateValue(record.dispatchObservedAt),
      warning: 'tool stream reception can lag dispatch; these are observations, not the <=5s gate' }
    record.credentialRoute = 'subscription'
    record.status = 'execution_proved_awaiting_server_timing'
  } catch (error) { record.status = 'failed'; record.error = safeError(error) }
  finally {
    if (record.messageSubmittedAt && !record.coordinatorStopped) {
      try { await client.rpc('coordinator.stopCoordinatorTurn', [botId]); record.coordinatorStopped = true }
      catch (error) { record.status = 'failed'; record.stopError = safeError(error) }
    }
    await cleanupCase(client, record, deviceId ? 'device' : 'cloud', { timeoutMs, WebSocketImpl, now })
  }
  return record
}

export async function runCloudStartup(options, { env = process.env, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now,
  readWorkerRelease = () => readProductionWorkerRelease({ token: env.VERCEL_TEAM_TOKEN, fetchImpl }) } = {}) {
  const email = env.ACME_DEMO_EMAIL, password = env.ACME_DEMO_PASSWORD
  assert(email?.toLowerCase() === 'alex@acme.aspectlylabs.com' && password, 'acme_account_required')
  assert(typeof WebSocketImpl === 'function', 'node_websocket_required')
  const client = createSessionClient(options.origin, fetchImpl), fixtureId = randomUUID()
  const report = { schemaVersion: 1, issue: 1505, fixtureId, startedAt: iso(now()), mode: options.mode,
    origin: options.origin, workspaceId: options.workspace, repository: REPOSITORY, requestedStrategy: options.strategy,
    strategyEvidence: 'operator_label_requires_template_or_pool_log_evidence', revision: options.revision ?? null,
    target: options.deviceId ? 'candidate_device' : 'cloud', maxStartupMs: options.maxStartupMs,
    timingMethod: 'dispatch_run_entry to later of agent_start database receipt and actual official task acceptance; missing entry boundary is legacy lower-bound evidence only',
    executionGate: options.runtimeEvidence === 'required' ? 'later_of_agent_start_and_actual_official_cli_acceptance' : 'legacy_agent_start_actual_ack_unavailable',
    samples: [], cleanup: { errors: [] }, status: 'running' }
  const profiles = new Map()
  let botId = options.botId, loggedIn = false, testBotValidated = false, timingVariableId
  const pin = async () => {
    const { build } = await client.json('/api/version')
    assert(typeof build === 'string' && build.length <= 200, 'build_missing')
    assert(!options.expectedBuild || build === options.expectedBuild, 'build_mismatch')
    assert(!report.build || report.build === build, 'build_changed')
    report.build = build
    if (options.expectedWorkerSha) {
      const release = await readWorkerRelease()
      assert(release.workerSha === options.expectedWorkerSha && release.sourceCommit === options.expectedWorkerSource, 'worker_release_mismatch')
      assert(!report.workerRelease || JSON.stringify(release) === JSON.stringify(report.workerRelease.configuration), 'worker_release_changed')
      report.workerRelease ??= { configuration: release, evidence: 'production_configuration_pin_requires_per_run_runtime_log_confirmation', checks: 0 }
      report.workerRelease.checks++
    }
  }
  try {
    await pin()
    const login = await client.request('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))
    assert(login.ok, 'sign_in_failed'); loggedIn = true
    const identity = await client.json('/api/auth/get-session')
    assert(identity.user?.email?.toLowerCase() === email.toLowerCase(), 'session_identity_mismatch')
    report.accountHash = sha(identity.user.id).slice(0, 16)
    await client.rpc('workspace.switchWorkspace', [options.workspace])
    if (options.officialTiming === 'enabled') {
      const listed = await client.rpc('workspace-secrets.listSecrets', [options.workspace])
      assert(Array.isArray(listed.secrets) && !listed.secrets.some(item => item.name === 'CLOUD_STARTUP_TIMING'), 'timing_variable_exists')
      const created = await client.rpc('workspace-secrets.createSecret', [{ name: 'CLOUD_STARTUP_TIMING', kind: 'env', value: '1',
        note: `测试1505 ${fixtureId}`, scope: { type: 'repository', repository: REPOSITORY } }, options.workspace])
      assert(UUID.test(created.id ?? ''), 'timing_variable_create_failed')
      timingVariableId = created.id
      report.officialTiming = { enabled: true, variableId: timingVariableId, scope: 'acceptance_repository_only' }
    }
    if (!botId) {
      const bot = await client.rpc('bots.createBot', [{ name: `测试1505 ${fixtureId.slice(0, 8)}`, color: 'gris', shape: 'cercle', model: null, repository: null }])
      assert(UUID.test(bot.id ?? ''), 'bot_create_failed'); botId = bot.id
      report.createdBotId = botId
      report.botRetention = 'dedicated test Bot retained; no public Bot deletion API'
    }
    const bot = await client.json(`/api/bots/${botId}`)
    assert(bot.id === botId && /^测试\s*1505(?:\s|$)/.test(bot.name ?? ''), 'test_bot_required')
    testBotValidated = true
    report.botId = botId
    const order = await client.rpc('model-order.getModelOrder', [options.workspace])
    const harnesses = options.harness === 'both' ? ['claude_code', 'codex'] : [options.harness]
    for (const harness of harnesses) {
      try {
        const candidate = order.candidates?.find(item => item.harness === harness && item.model === MODELS[harness]
          && item.source?.kind === 'subscription' && UUID.test(item.source.connectionId ?? ''))
        assert(candidate, 'subscription_model_missing')
        const created = await client.json('/api/factory/agent-profiles', post({ workspaceId: options.workspace, requestId: randomUUID(), profile: {
          name: `测试1505 ${fixtureId.slice(0, 8)} ${harness}`, description: 'Temporary startup measurement', enabled: true,
          harness, model: { mode: 'fixed', harness, model: MODELS[harness], source: candidate.source }, effort: 'low', roles: [],
          instructions: 'This is a read-only startup test. Do not modify files, commit, push, create a PR, send external messages, or spawn agents.', skills: [],
        } }))
        assert(UUID.test(created.profile?.id ?? '') && Number.isInteger(created.profile.version), 'profile_create_failed')
        profiles.set(harness, created.profile)
      } catch (error) { profiles.set(harness, { error: safeError(error) }) }
    }
    for (let index = 0; index < options.runs; index++) {
      const harness = harnesses[index % harnesses.length], sampleId = `${fixtureId.slice(0, 8)}_${index + 1}`
      const profile = profiles.get(harness)
      if (profile?.error) {
        report.samples.push({ sampleId, harness, status: 'failed', error: profile.error, cleanup: { status: 'passed', errors: [] } })
        continue
      }
      const sample = await runSubscriptionCase({ client, ...options, botId, profileId: profile.id, harness, sampleId,
        sourceCommit: options.revision, pinBuild: pin, now, WebSocketImpl })
      report.samples.push(sample)
      if (['startup_build_mismatch', 'startup_build_changed', 'startup_worker_release_mismatch', 'startup_worker_release_changed'].includes(sample.error)) {
        report.batchAborted = 'version_pin_changed'
        fail(sample.error.slice('startup_'.length))
      }
    }
    await pin()
  } catch (error) { report.error = safeError(error) }
  finally {
    if (loggedIn) {
      if (timingVariableId) {
        try { await client.rpc('workspace-secrets.deleteSecret', [{ id: timingVariableId }, options.workspace]); report.officialTiming.cleaned = true }
        catch (error) { report.cleanup.errors.push({ step: 'timing_variable_delete', id: timingVariableId, code: safeError(error) }) }
      }
      for (const profile of profiles.values()) if (profile.id) {
        try { await client.json(`/api/factory/agent-profiles/${profile.id}`, { ...post({ workspaceId: options.workspace, version: profile.version }), method: 'DELETE' }) }
        catch (error) { report.cleanup.errors.push({ step: 'profile_archive', id: profile.id, code: safeError(error) }) }
      }
      if (testBotValidated) {
        try { await client.rpc('coordinator.stopCoordinatorTurn', [botId]) }
        catch (error) { report.cleanup.errors.push({ step: 'stop_test_bot', code: safeError(error) }) }
      }
      try { const response = await client.request('/api/auth/sign-out', post({})); assert(response.ok, 'sign_out_failed') }
      catch (error) { report.cleanup.errors.push({ step: 'sign_out', code: safeError(error) }) }
    }
    client.clear()
  }
  report.finishedAt = iso(now())
  report.status = report.error || report.cleanup.errors.length || report.samples.length !== options.runs
    || report.samples.some(sample => sample.status === 'failed' || sample.cleanup.status !== 'passed') ? 'failed'
      : options.mode === 'candidate' && report.samples.every(sample => sample.replyVerified) ? 'candidate_subscription_proved'
        : 'awaiting_server_timings'
  return report
}

/** Match unambiguously, never infer a dispatch timestamp from a tool preview.
 * Input is a JSON array of sanitized dispatch_timing log objects; no Vercel
 * credentials, request headers or raw application log envelopes are needed. */
export function alignServerTimings(report, timings) {
  assert(Array.isArray(timings), 'timings_invalid')
  const clean = timings.filter(item => item?.msg === 'dispatch_timing' && typeof item.workflowRunId === 'string'
    && Number.isSafeInteger(item.startedAt) && Number.isSafeInteger(item.endedAt) && item.endedAt >= item.startedAt
    && Number.isFinite(item.totalMs) && item.failed === false)
  for (const sample of report.samples) {
    if (!sample.agentStart || !sample.firstProviderChunk) continue
    let matching = clean.filter(item => item.workflowRunId === sample.workflowRunId)
    // One durable workflow can dispatch several chat turns. Correlate using
    // the owned run's server-side ensure interval, never runner wall clocks.
    if (matching.length > 1) {
      const owned = timings.filter(item => item?.msg === 'cloud_startup_timing' && item.stage === 'cloud.thread.ensure'
        && item.runIdHash === sample.runIdHash && Number.isSafeInteger(item.startedAt) && Number.isSafeInteger(item.endedAt))
      if (owned.length) matching = matching.filter(item => owned.some(run => run.startedAt >= item.startedAt && run.endedAt <= item.endedAt))
    }
    if (matching.length !== 1) { sample.timing = { status: 'unavailable', reason: matching.length ? 'ambiguous_dispatch' : 'dispatch_log_missing' }; continue }
    const log = matching[0], end = dateValue(sample.agentStart.storedAt), provider = dateValue(sample.firstProviderChunk.storedAt)
    if (![end, provider].every(Number.isFinite) || end < log.startedAt || provider < end) {
      sample.timing = { status: 'unavailable', reason: 'clock_or_receipt_invalid' }; continue
    }
    // Anchor to the database's conservative stage receipt and add only the
    // later CLI event's same-process monotonic offset. Never subtract clocks
    // on different machines to manufacture a faster execution time.
    const runtime = sample.runtimeTiming
    const acceptedKind = runtime?.harness === 'claude_code' ? 'claude_user_ack' : 'codex_turn_start_ack'
    const acceptanceOffset = runtime?.agentAccepted?.kind === acceptedKind && Number.isFinite(runtime.executionStartMs)
      ? Math.max(0, runtime.agentAccepted.ms - runtime.executionStartMs) : null
    const executionEnd = acceptanceOffset === null ? end : end + acceptanceOffset
    const dispatchBoundary = log.boundary === 'dispatch_run_entry' ? 'dispatch_run_entry' : 'legacy_dispatch_body'
    sample.timing = { status: 'aligned', source: 'server_dispatch_log_to_database_receipt', stepId: log.stepId ?? null,
      dispatchBoundary, dispatchBoundaryVerified: dispatchBoundary === 'dispatch_run_entry',
      dispatchStartedAt: iso(log.startedAt), dispatchEndedAt: iso(log.endedAt), dispatchCallMs: log.totalMs,
      dispatchToAgentStartMs: end - log.startedAt, dispatchToFirstProviderChunkMs: provider - log.startedAt,
      actualAgentAcceptance: acceptanceOffset === null ? 'unavailable_on_legacy_worker' : 'official_event_observed',
      ...(acceptanceOffset === null ? {} : { agentAcceptanceAfterStageMs: acceptanceOffset,
        dispatchToExecutionStartMs: executionEnd - log.startedAt, executionTimeSource: 'stage_database_receipt_plus_monotonic_offset_upper_bound' }),
      phases: Array.isArray(log.phases) ? log.phases.filter(phase => /^[A-Za-z0-9_.]+$/.test(phase.phase ?? '') && Number.isFinite(phase.ms))
        .map(({ phase, ms }) => ({ phase, ms })) : [], withinTarget: dispatchBoundary === 'dispatch_run_entry'
          && acceptanceOffset !== null && executionEnd - log.startedAt <= report.maxStartupMs }
  }
  const complete = !report.error && !report.cleanup.errors.length && report.samples.length > 0
    && report.samples.every(sample => sample.status !== 'failed' && sample.execution?.credentialType === 'subscription' && sample.agentStart
      && (!sample.requireRuntimeReceipt || sample.runtimeEvidence?.status === 'passed')
      && sample.firstProviderChunk && sample.cleanup?.status === 'passed' && (report.mode === 'candidate'
        ? sample.replyVerified : sample.timing?.status === 'aligned'))
  report.status = !complete ? 'failed' : report.mode === 'baseline' ? 'baseline_recorded'
    : report.mode === 'candidate' ? 'candidate_subscription_proved'
      : report.target === 'cloud' && report.samples.length >= 3 && report.samples.every(sample => sample.timing.withinTarget) ? 'passed' : 'failed'
  return report
}

const HELP = `Cloud startup acceptance (#1505)\n\nNormal live run (ACME_DEMO_EMAIL/PASSWORD in environment):\n  node scripts/acceptance/cloud-startup.mjs --workspace UUID --runs 6 --harness both --mode baseline --strategy official --output report.json\n\nProduction acceptance also requires --expected-build BUILD --revision COMMIT.\n--expected-worker-sha HASH --expected-worker-source COMMIT uses VERCEL_TEAM_TOKEN for read-only configuration pins before and after each run. Actual runtime SHA requires the corresponding startup log evidence.\n--strategy official|derived|pool|combined is an operator label, not template proof.\n--mode candidate --runs 1 --harness codex --device-id UUID --agent-id UUID validates a candidate's normal subscription path; it is not cloud latency acceptance.\n\nOffline alignment after extracting matching dispatch_timing logs:\n  node scripts/acceptance/cloud-startup.mjs --align-report report.json --dispatch-timings timings.json --output aligned.json\n\nOptions: --origin HTTPS_ORIGIN --bot-id UUID --timeout-ms 240000 --max-startup-ms 5000\nNo login credentials, cookies, provider output, or live tickets are written.\n`

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let output
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) console.log(HELP)
    else {
      output = resolve(options.output)
      let report = options.alignReport
        ? alignServerTimings(JSON.parse(await readFile(options.alignReport, 'utf8')), JSON.parse(await readFile(options.dispatchTimings, 'utf8')))
        : await runCloudStartup(options)
      if (!options.alignReport && options.dispatchTimings) report = alignServerTimings(report, JSON.parse(await readFile(options.dispatchTimings, 'utf8')))
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      console.log(JSON.stringify({ status: report.status, samples: report.samples.length, report: output }))
      if (report.status === 'failed' || (options.mode === 'acceptance' && report.status !== 'passed')) process.exitCode = 1
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: safeError(error), ...(output ? { report: output } : {}) }))
    process.exitCode = 1
  }
}
