// Temporary production acceptance client. Explicit invocation only; no retries or polling.
// Protocol inspected with git show origin/main:<path> at the revision below (includes #1490).
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { decode, productionSession } from './production-session.mjs'

export const PROTOCOL_SOURCE_SHA = 'e8dd7a1265027a0477819dde1a80178e7bcdb1ae'
export const TARGET_WORKSPACE_REF = 'e917cd887945'
const EXPECTED_MODEL = 'claude-haiku-5-5'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const RUN = /^wrun_[a-zA-Z0-9_-]{1,160}$/
const reference = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
const milliseconds = value => Math.round(value * 10) / 10
const safeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const fixedErrors = new Set([
  'acceptance_sha_required', 'acceptance_version_mismatch', 'acceptance_version_changed',
  'smoke_credentials_missing', 'acceptance_identity_mismatch', 'acceptance_deadline_exceeded',
  'acceptance_http_failed', 'acceptance_rpc_failed', 'acceptance_signout_failed',
  'workspace_inventory_invalid', 'workspace_target_missing', 'workspace_switch_failed',
  'chat_invalid', 'chat_not_idle', 'chat_live_scope_invalid', 'model_not_shared_haiku',
  'live_ticket_invalid', 'live_ready_timeout', 'live_connection_failed', 'live_not_supported',
  'send_not_queued', 'stream_status_invalid', 'stream_headers_invalid', 'stream_event_invalid',
  'stream_sequence_invalid', 'stream_turn_mismatch', 'stream_error', 'stream_deadline',
  'first_text_missing', 'unexpected_tool', 'stop_request_failed', 'stop_boundary_missed',
  'stop_not_quiescent', 'post_stop_chat_failed', 'live_push_missing', 'live_close_failed',
])
const code = error => fixedErrors.has(error?.message) ? error.message : 'acceptance_unexpected_failure'
const fail = name => { throw new Error(name) }

export function requireExactSha(value) {
  if (!SHA.test(value ?? '')) fail('acceptance_sha_required')
  return value
}

export function verifySharedHaiku(menu) {
  const current = menu?.current
  const manuallyListed = Array.isArray(menu?.groups) && menu.groups.some(group =>
    Array.isArray(group.options) && group.options.some(option => option.id === current?.id))
  if (!current || current.modelId !== EXPECTED_MODEL || current.provider !== 'claude'
    || current.kind !== 'subscription' || !(current.available === true || current.available === false && current.availability === 'checking') || current.chosen !== false
    || typeof current.id !== 'string' || !current.id || manuallyListed) fail('model_not_shared_haiku')
  return { model: EXPECTED_MODEL, provider: 'claude', kind: 'subscription', available: current.available,
    availability: current.available ? 'available' : 'checking', admissionPending: !current.available,
    chosen: false, listedAsOwnOption: false, sharedInference: 'resolved_subscription_absent_from_manual_options',
    runtimeModelConfirmed: false }
}

export async function readJson(session, path, { body, headers, signal, timeoutMs = 20_000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await session.request(path, { body, headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  let value
  try { value = await response.json() } catch (error) { throw new Error('acceptance_http_failed', { cause: error }) }
  if (!response.ok || value?.error) fail('acceptance_http_failed')
  return value
}

export async function rpc(session, action, args = [], options = {}) {
  const envelope = await readJson(session, '/api/rpc', {
    ...options, body: { version: 1, action, args }, headers: { 'x-mikka-rpc': '1' },
  })
  const result = decode(envelope?.result)
  if (envelope?.ok !== true || result?.error) fail('acceptance_rpc_failed')
  return result
}

export function validateChat(result) {
  const chat = result?.chat
  if (!chat || !UUID.test(chat.botId ?? '') || !Array.isArray(chat.items)
    || typeof chat.working !== 'boolean' || chat.unchanged) fail('chat_invalid')
  return chat
}

/** Same field validation as lib/coordinator-stream-client.ts; retain no tool payloads. */
export function parseStreamLine(line) {
  let value
  try { value = JSON.parse(line) } catch (error) { throw new Error('stream_event_invalid', { cause: error }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('stream_event_invalid')
  if (value.sequence !== undefined && (!Number.isSafeInteger(value.sequence) || value.sequence < 1)) fail('stream_sequence_invalid')
  if (value.type === 'error') return { type: 'error', sequence: value.sequence }
  if (typeof value.id !== 'string') fail('stream_event_invalid')
  const event = { type: value.type, id: value.id, sequence: value.sequence }
  if (value.type === 'start') return event
  if (value.type === 'text' && typeof value.delta === 'string') return { ...event, text: value.delta }
  if (value.type === 'reset' && typeof value.text === 'string') return { ...event, text: value.text }
  if (value.type === 'committed' && Number.isSafeInteger(value.through) && value.through >= 0
    && typeof value.quiet === 'boolean') return event
  if (value.type === 'tool' && typeof value.call === 'string' && typeof value.name === 'string'
    && ['running', 'done', 'error'].includes(value.state)) return { ...event, state: value.state }
  if (value.type === 'thinking' && (value.state === 'start' || value.state === 'end')) return event
  if (value.type === 'thinking' && ['delta', 'reset'].includes(value.state) && typeof value.text === 'string') return event
  fail('stream_event_invalid')
}

/** Incremental NDJSON/UTF-8. A true callback result closes this reader immediately. */
export async function readStream(body, onEvent, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = '', sequence = 0, terminal = null
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const emit = line => {
    const event = parseStreamLine(line)
    if (event.type === 'error') fail('stream_error')
    // This fresh stream has no replay cursor. A missing or non-consecutive sequence is not accepted.
    if (event.sequence !== sequence + 1) fail('stream_sequence_invalid')
    sequence = event.sequence
    if (onEvent(event)) terminal = 'committed'
  }
  try {
    while (!terminal && !signal?.aborted) {
      const { done, value } = await reader.read()
      if (signal?.aborted) break
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline
      while (!terminal && (newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line) emit(line)
      }
      if (done) {
        if (!terminal && buffered.trim()) emit(buffered)
        terminal ??= 'eof'
      }
    }
    return terminal ?? 'timeout'
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** One authenticated owner/home socket, with no reconnect, refresh or heartbeat interval. */
export async function openLiveObserver(session, chat, { readyTimeoutMs = 15_000, WebSocketClass = WebSocket } = {}) {
  if (chat.live?.ownerId !== session.identity.userId || !UUID.test(chat.live?.workspaceId ?? '')) fail('chat_live_scope_invalid')
  const ticket = await readJson(session, '/api/live/ticket?workspace=' + chat.live.workspaceId)
  let url
  try { url = new URL(ticket?.url) } catch (error) { throw new Error('live_ticket_invalid', { cause: error }) }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash
    || !/^\/v1\/live\/[a-f0-9]{64}\/socket$/.test(url.pathname)
    || typeof ticket.protocol !== 'string' || !ticket.protocol
    || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= Date.now()) fail('live_ticket_invalid')
  url.searchParams.set('revisions', '1')
  const socket = new WebSocketClass(url.href, ticket.protocol)
  const baselineRevision = chat.live.revisions?.['bot_chat:' + chat.botId.toLowerCase()]
  const summary = { ready: false, revisionCapable: false, baselineRevision: safeNumber(baselineRevision),
    matchingPushes: 0, versionedPushes: 0, newerPushes: 0, firstPushMs: null, maxRevision: null,
    unexpectedDisconnect: false, closed: false, chatReadsTriggered: 0 }
  let started = null, readyResolve, readyReject, closing = false
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const timer = setTimeout(() => readyReject(new Error('live_ready_timeout')), readyTimeoutMs)
  socket.addEventListener('open', () => socket.send('ping'))
  socket.addEventListener('error', () => readyReject(new Error('live_connection_failed')))
  socket.addEventListener('close', () => { if (!closing) summary.unexpectedDisconnect = true; readyReject(new Error('live_connection_failed')) })
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || event.data.length > 2048 || event.data === 'pong') return
    let data
    try { data = JSON.parse(event.data) } catch { return }
    if (data?.type === 'live_ready') {
      if (![1, 2].includes(data.version) || !Array.isArray(data.kinds) || !data.kinds.includes('bot_chat')) {
        readyReject(new Error('live_not_supported')); return
      }
      summary.ready = true
      summary.revisionCapable = data.version === 2 && Array.isArray(data.revisions) && data.revisions.includes('bot_chat')
      readyResolve()
    } else if (started !== null && data?.kind === 'bot_chat' && typeof data.id === 'string' && UUID.test(data.id) && data.id.toLowerCase() === chat.botId.toLowerCase()) {
      const keys = Object.keys(data)
      const rev = Number.isSafeInteger(data.rev) && data.rev > 0 ? data.rev : null
      if (!(keys.length === 2 || keys.length === 3 && rev !== null && summary.revisionCapable)) return
      summary.matchingPushes++
      summary.firstPushMs ??= milliseconds(performance.now() - started)
      if (rev !== null) {
        summary.versionedPushes++
        summary.maxRevision = Math.max(summary.maxRevision ?? 0, rev)
        if (rev > (summary.baselineRevision ?? 0)) summary.newerPushes++
      }
    }
  })
  const close = async () => {
    clearTimeout(timer)
    closing = true
    if (socket.readyState === 3) { summary.closed = true; return true }
    const closed = new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 3_000)
      socket.addEventListener('close', () => { clearTimeout(timeout); resolve(true) }, { once: true })
    })
    socket.close(1000)
    summary.closed = await closed
    return summary.closed
  }
  try { await ready } catch (error) { await close(); throw error } finally { clearTimeout(timer) }
  return { summary, begin: at => { started = at }, close }
}

export async function runBaseline({ env = process.env, sessionProvider = productionSession,
  openLive = openLiveObserver, targetWorkspaceRef = TARGET_WORKSPACE_REF,
  streamTimeoutMs = 60_000, stopTimeoutMs = 20_000 } = {}) {
  const report = { schemaVersion: 1, issue: 1506, case: 'first-text-and-model-stream-stop',
    protocolSourceSha: PROTOCOL_SOURCE_SHA, applicationSha: null, status: 'failed',
    origin: 'https://app.aspectlylabs.com/mikka', startedAt: new Date().toISOString(),
    messageSendAttempts: 0, taskCreationRequests: 0, modelSelectionWrites: 0, postStopChatReads: 0,
    metrics: {}, stop: { requested: false, acknowledged: false, termination: null },
    runtimeEvidence: { confirmed: false, required: 'model_call_timing_for_workflowRunId' },
    remainingCases: { beforeTool: 'not_run', duringTool: 'not_run' } }
  let requests = []
  try {
    const expectedSha = requireExactSha(env.MIKKA_ACCEPTANCE_SHA)
    report.applicationSha = expectedSha
    await sessionProvider(async session => {
      requests = session.requests
      if (session.version?.build !== expectedSha) fail('acceptance_version_mismatch')
      const switcher = await readJson(session, '/api/workspace/switcher')
      const account = switcher.accounts?.find(row => row.id === session.identity.userId)
      if (!account || !Array.isArray(account.choices)) fail('workspace_inventory_invalid')
      const targets = account.choices.filter(row => UUID.test(row.id ?? '') && row.kind === 'team' && reference(row.id) === targetWorkspaceRef)
      if (targets.length !== 1) fail('workspace_target_missing')
      const workspaceId = targets[0].id
      const switched = await rpc(session, 'workspace.switchWorkspace', [workspaceId])
      if (switched?.ok !== true || switched.data?.workspaceId !== workspaceId) fail('workspace_switch_failed')
      report.workspace = { ref: targetWorkspaceRef, kind: 'team', switchedThroughProductAction: true }
      const initial = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [null]))
      if (!initial.enabled || initial.working || initial.streamRunId) fail('chat_not_idle')
      const botId = initial.botId
      report.botRef = reference(botId)
      report.menu = verifySharedHaiku(await rpc(session, 'execution-settings.getBotModelMenu', [botId]))
      let live, streamController, stopPromise = null, sent = false, streamId = null, error = null, started
      const since = () => milliseconds(performance.now() - started)
      const requestStop = trigger => {
        if (stopPromise) return stopPromise
        report.stop.requested = true
        report.stop.trigger = trigger
        report.metrics.stopRequestedMs = since()
        stopPromise = rpc(session, 'coordinator.stopCoordinatorTurn', [botId], { timeoutMs: stopTimeoutMs })
          .then(result => {
            report.metrics.stopAcknowledgedMs = since()
            report.stop.acknowledged = result?.stopped === true
            return result?.stopped === true
          }).catch(error => { report.stop.error = code(error); return false })
        return stopPromise
      }
      try {
        live = await openLive(session, initial)
        report.live = live.summary
        if ((await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
        const submissionId = randomUUID()
        // Synthetic text only. It asks for no work, tools, browsing or side effects.
        const prompt = '冒烟验收：这是首字与停止测试。不要调用工具、创建任务、写文件或查询任何外部信息。只从 1 连续数到 600，每个数字之间一个空格；直接开始，不要说明。'
        started = performance.now()
        report.sentAt = new Date().toISOString()
        live.begin(started)
        report.messageSendAttempts++
        // Mark the attempted send for cleanup even if its HTTP acknowledgement is lost.
        sent = true
        const queued = await rpc(session, 'coordinator.sendCoordinatorMessage', [prompt, null, botId, submissionId])
        report.metrics.sendAcknowledgedMs = since()
        if (queued?.queued !== true) fail('send_not_queued')
        streamController = new AbortController()
        let deadline = setTimeout(() => streamController.abort('stream_deadline'), streamTimeoutMs)
        try {
          report.metrics.streamRequestedMs = since()
          const response = await session.request('/api/coordinator/stream?wait=1&botId=' + botId, { signal: streamController.signal })
          report.metrics.streamHeadersMs = since()
          report.streamStatus = response.status
          if (response.status !== 200) { await response.body?.cancel(); fail('stream_status_invalid') }
          const runId = response.headers.get('x-mikka-stream-run')
          if (!RUN.test(runId ?? '') || !response.headers.get('content-type')?.startsWith('application/x-ndjson')
            || !response.headers.get('x-mikka-stream-key') || !response.body) {
            await response.body?.cancel(); fail('stream_headers_invalid')
          }
          report.workflowRunId = runId
          report.streamEvents = { start: 0, text: 0, reset: 0, committed: 0, thinking: 0, tool: 0,
            textCharacters: 0, textCharactersAfterStop: 0 }
          report.stop.termination = await readStream(response.body, event => {
            if (!event.id.startsWith(runId + ':')) fail('stream_turn_mismatch')
            report.streamEvents[event.type]++
            if (event.type === 'start') {
              if (streamId && streamId !== event.id) fail('stream_turn_mismatch')
              streamId = event.id
              report.metrics.streamStartedMs ??= since()
            }
            if (!streamId || event.id !== streamId) fail('stream_turn_mismatch')
            if (event.type === 'tool') { requestStop('unexpected_tool'); fail('unexpected_tool') }
            if (event.type === 'text' || event.type === 'reset') {
              const characters = Array.from(event.text).length
              report.streamEvents.textCharacters += characters
              if (report.stop.requested) report.streamEvents.textCharactersAfterStop += characters
              if (characters > 0 && report.metrics.firstTextMs === undefined) {
                report.metrics.firstTextMs = since()
                report.metrics.headersToFirstTextMs = milliseconds(report.metrics.firstTextMs - report.metrics.streamHeadersMs)
                report.firstTextTargetMet = report.metrics.firstTextMs <= 3_000
                // Trigger on the observed boundary, never on an arbitrary sleep.
                requestStop('first_visible_text')
                clearTimeout(deadline)
                deadline = setTimeout(() => streamController.abort('stop_deadline'), stopTimeoutMs)
              }
            }
            // committed precedes the workflow's next takeInbox/releaseLease. Keep reading
            // to EOF before the one chat read, so that lease tail cannot create a false failure.
            if (event.type === 'committed') { report.metrics.committedMs = since(); report.stop.committedObserved = true }
            return false
          }, streamController.signal)
          report.metrics.streamClosedMs = since()
        } catch (cause) {
          if (streamController.signal.aborted) {
            report.stop.termination = 'timeout'
            throw new Error('stream_deadline', { cause })
          }
          throw cause
        } finally {
          clearTimeout(deadline)
          streamController.abort()
          report.streamClosed = true
          report.metrics.streamClosedMs ??= since()
          if (report.metrics.stopRequestedMs !== undefined) report.metrics.stopToStreamClosedMs = milliseconds(report.metrics.streamClosedMs - report.metrics.stopRequestedMs)
        }
        if (report.metrics.firstTextMs === undefined) fail('first_text_missing')
        if (!await stopPromise) fail('stop_boundary_missed')
        if (report.stop.termination === 'timeout') fail('stream_deadline')
      } catch (cause) { error = cause }
      finally {
        if (sent) {
          // One stop attempt for this idle-to-owned-message case; no retries and no unrelated pre-existing turn.
          if (!stopPromise) requestStop('error_cleanup')
          await stopPromise
          streamController?.abort()
          report.postStopChatReads++
          try {
            const after = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [botId]))
            report.metrics.postStopChatMs = since()
            if (after.botId !== botId) fail('chat_invalid')
            const ownItems = streamId ? after.items.filter(item => item.streamId === streamId) : []
            report.afterStop = { working: after.working, activeStream: Boolean(after.streamRunId),
              ownPersistedItems: ownItems.length, stoppedMarker: ownItems.some(item => item.stopped === true) }
            if (!after.working && !after.streamRunId) report.metrics.stopToObservedIdleMs = milliseconds(report.metrics.postStopChatMs - report.metrics.stopRequestedMs)
            if (after.working || after.streamRunId) error ??= new Error('stop_not_quiescent')
          } catch (cause) { error ??= new Error('post_stop_chat_failed', { cause }) }
        }
        if (live) {
          if (!await live.close()) error ??= new Error('live_close_failed')
          if (sent && !live.summary.matchingPushes) error ??= new Error('live_push_missing')
        }
      }
      if (error) throw error
      if ((await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
      report.applicationVersionStable = true
      report.status = 'observed'
    }, { expectedSha, deadlineAt: Date.now() + 180_000 })
    const signout = requests.findLast(row => row.path === '/mikka/api/auth/sign-out')
    if (!signout || signout.status < 200 || signout.status >= 300) fail('acceptance_signout_failed')
    report.signedOut = true
  } catch (error) { report.status = 'failed'; report.error = code(error) }
  // Whitelist stable route names; no query parameters, payloads, IDs, credentials, names or history.
  const routes = new Set(['/mikka/api/auth/sign-in/email', '/mikka/api/auth/get-session', '/mikka/api/auth/sign-out',
    '/mikka/api/version', '/mikka/api/workspace/switcher', '/mikka/api/rpc', '/mikka/api/live/ticket', '/mikka/api/coordinator/stream'])
  report.requests = requests.filter(row => routes.has(row.path)).map(({ path, method, status, headersMs }) =>
    ({ path, method: method === 'POST' ? 'POST' : 'GET', status: Number.isInteger(status) ? status : null, headersMs: safeNumber(headersMs) }))
  report.finishedAt = new Date().toISOString()
  return report
}

/** Offline correlation only. Evidence must come from the exact build's real server logs. */
export function confirmRuntime(report, evidence) {
  if (report?.status !== 'observed' || !SHA.test(report.applicationSha ?? '') || evidence?.applicationSha !== report.applicationSha
    || !RUN.test(report.workflowRunId ?? '') || !Array.isArray(evidence?.logs)) throw new Error('runtime_evidence_mismatch')
  const calls = evidence.logs.filter(line => line?.msg === 'model_call_timing' && line.workflowRunId === report.workflowRunId)
  if (!calls.length || calls.some(line => line.model !== EXPECTED_MODEL || line.route !== 'subscription')) throw new Error('runtime_model_unverified')
  const interrupted = calls.find(line => line.interrupted === true && safeNumber(line.firstTextMs) !== null && line.toolCalls === 0)
  if (!interrupted || !report.stop.acknowledged || report.afterStop?.working !== false || report.afterStop?.activeStream !== false
    || report.stop.trigger !== 'first_visible_text' || !['eof', 'committed'].includes(report.stop.termination)) throw new Error('runtime_stop_unverified')
  // Do not copy unfiltered log records into the report.
  return { ...report, status: 'baseline_verified', menu: { ...report.menu, runtimeModelConfirmed: true },
    runtimeEvidence: { confirmed: true, model: EXPECTED_MODEL, route: 'subscription', matchingCalls: calls.length,
      interrupted: true, firstTextMs: safeNumber(interrupted.firstTextMs), setupMs: safeNumber(interrupted.setupMs),
      durationMs: safeNumber(interrupted.durationMs), cacheReadTokens: safeNumber(interrupted.cacheReadTokens),
      cacheWriteTokens: safeNumber(interrupted.cacheWriteTokens) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2]
  if (mode === 'first-text-stop') {
    const report = await runBaseline()
    mkdirSync('issue-1504-1506-report', { recursive: true })
    writeFileSync('issue-1504-1506-report/coordinator-baseline.json', JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
    if (report.status !== 'observed') process.exitCode = 1
  } else if (mode === 'confirm-runtime' && process.argv[3] && process.argv[4]) {
    try {
      const report = confirmRuntime(JSON.parse(readFileSync(process.argv[3], 'utf8')), JSON.parse(readFileSync(process.argv[4], 'utf8')))
      const path = process.argv[3].replace(/\.json$/, '') + '.verified.json'
      writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
      console.log(JSON.stringify({ status: report.status, firstTextTargetMet: report.firstTextTargetMet,
        actualModel: report.runtimeEvidence.model, interrupted: true }))
    } catch { console.error(JSON.stringify({ status: 'failed', error: 'runtime_confirmation_failed' })); process.exitCode = 1 }
  } else {
    console.log('Usage: node coordinator-baseline.mjs first-text-stop | confirm-runtime <report.json> <evidence.json>')
    console.log('first-text-stop requires MIKKA_ACCEPTANCE_SHA (exact 40-character production SHA) and the normal smoke credentials.')
  }
}
