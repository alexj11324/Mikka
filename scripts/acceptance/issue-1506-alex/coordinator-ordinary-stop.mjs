// Ordinary Stop acceptance on retained owned fixtures. Historical baseline stays unchanged.
// Actual committed + persisted stopped marker + lease idle end this observation; EOF is not required.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { alexSession } from '../issue-1506-readonly/alex-session.mjs'
import { readJson, requireExactSha, rpc, validateChat }
  from '../issue-1504-1506/coordinator-baseline.mjs'
import { FIXTURE_ERRORS, openAcceptanceFixture, OUTPUT_DIR } from './coordinator-fixtures.mjs'
import { CACHE_PROTOCOL_SOURCE_SHA, openCacheLive, observeStoppedCompletion } from './coordinator-cache-completion.mjs'

const RUN = /^wrun_[a-zA-Z0-9_-]{1,160}$/
const milliseconds = value => Math.round(value * 10) / 10
const safeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const fixedErrors = new Set([...FIXTURE_ERRORS,
  'acceptance_sha_required', 'acceptance_version_mismatch', 'acceptance_version_changed',
  'alex_credentials_missing', 'acceptance_identity_mismatch', 'acceptance_deadline_exceeded',
  'acceptance_http_failed', 'acceptance_rpc_failed', 'acceptance_signout_failed',
  'workspace_inventory_invalid', 'workspace_target_missing', 'workspace_switch_failed',
  'chat_invalid', 'chat_not_idle', 'chat_live_scope_invalid', 'model_not_shared_haiku',
  'live_ticket_invalid', 'live_ready_timeout', 'live_connection_failed', 'live_not_supported',
  'send_not_queued', 'stream_status_invalid', 'stream_headers_invalid', 'stream_event_invalid',
  'stream_sequence_invalid', 'stream_turn_mismatch', 'stream_error', 'stream_deadline',
  'first_text_missing', 'unexpected_tool', 'stop_request_failed', 'stop_boundary_missed',
  'stop_not_quiescent', 'post_stop_chat_failed', 'live_push_missing', 'live_close_failed',
  'committed_invalid', 'stream_incomplete', 'chat_completion_error', 'reply_failed_or_stopped',
  'chat_revision_stale', 'stream_replay_unproven', 'reply_not_persisted', 'timeout_invalid',
])
const code = error => fixedErrors.has(error?.message) ? error.message : 'acceptance_unexpected_failure'
const fail = name => { throw new Error(name) }

export async function runOrdinaryStop({ env = process.env, sessionProvider = alexSession,
  openLive = openCacheLive, fixtureReceipt = null, checkpoint = true,
  streamTimeoutMs = 60_000, stopTimeoutMs = 20_000 } = {}) {
  const report = { schemaVersion: 1, issue: 1506, case: 'first-text-and-model-stream-stop',
    protocolSourceSha: CACHE_PROTOCOL_SOURCE_SHA, applicationSha: null, status: 'failed',
    origin: 'https://app.aspectlylabs.com/mikka', startedAt: new Date().toISOString(),
    messageSendAttempts: 0, taskCreationRequests: 0, modelSelectionWrites: 0, postStopChatReads: 0, completionChatReads: 0, cleanupChatReads: 0, chatReads: [],
    cleanup: { status: 'not_started', liveClosed: false },
    metrics: {}, stop: { requested: false, acknowledged: false, termination: null },
    runtimeEvidence: { confirmed: false, required: 'model_call_timing_for_workflowRunId' },
    remainingCases: { beforeTool: 'not_run', duringTool: 'not_run' } }
  let requests = []
  const save = () => {
    if (!checkpoint) return
    mkdirSync(OUTPUT_DIR, { recursive: true })
    const key = report.fixture?.key === 'luna' ? 'luna' : 'haiku'
    writeFileSync(`${OUTPUT_DIR}/coordinator-ordinary-stop-${key}.json`, JSON.stringify(report, null, 2) + '\n')
  }
  try {
    const expectedSha = requireExactSha(env.MIKKA_ACCEPTANCE_SHA)
    if (!(streamTimeoutMs > 0 && streamTimeoutMs <= 60_000 && stopTimeoutMs > 0 && stopTimeoutMs <= 20_000)) fail('timeout_invalid')
    report.applicationSha = expectedSha
    await sessionProvider(async session => {
      requests = session.requests
      if (session.version?.build !== expectedSha) fail('acceptance_version_mismatch')
      const fixture = await openAcceptanceFixture(session, env, fixtureReceipt)
      report.fixture = { key: fixture.fixtureKey, runKey: fixture.fixtureRunKey, botId: fixture.botId }
      report.workspace = { ref: fixture.workspace.ref, kind: 'team', switchedThroughProductAction: true }
      const initial = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [fixture.botId]))
      if (initial.botId !== fixture.botId) fail('fixture_scope_mismatch')
      if (!initial.enabled || initial.working || initial.streamRunId || initial.error) fail('chat_not_idle')
      const botId = fixture.botId
      report.initialCursor = initial.cursor
      report.botRef = fixture.botRef
      report.menu = fixture.menu
      let live, streamController, stopPromise = null, sent = false, streamId = null, error = null, completed = null, started
      const since = () => milliseconds(performance.now() - started)
      const requestStop = trigger => {
        if (stopPromise) return stopPromise
        report.stop.requested = true
        report.stop.trigger = trigger
        report.metrics.stopRequestedMs = since(); report.stop.requestedAt = Date.now()
        stopPromise = rpc(session, 'coordinator.stopCoordinatorTurn', [botId], { timeoutMs: stopTimeoutMs })
          .then(result => {
            report.metrics.stopAcknowledgedMs = since(); report.stop.acknowledgedAt = Date.now()
            report.stop.acknowledged = result?.stopped === true
            return result?.stopped === true
          }).catch(error => { report.stop.error = code(error); return false })
        save(); return stopPromise
      }
      try {
        live = await openLive(session, initial)
        report.live = live.summary
        if ((await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
        const submissionId = randomUUID()
        // Synthetic text only. It asks for no work, tools, browsing or side effects.
        const prompt = '测试验收：这是首字与停止测试。不要调用工具、创建任务、写文件或查询任何外部信息。只从 1 连续数到 600，每个数字之间一个空格；直接开始，不要说明。'
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
          completed = await observeStoppedCompletion({ body: response.body, runId, botId,
            initialChat: initial, live, signal: streamController.signal,
            readChat: async signal => {
              report.completionChatReads++; report.postStopChatReads++
              return validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [botId], { signal }))
            },
            onEvent: event => {
              report.streamEvents[event.type]++
              if (event.type === 'start') {
                streamId = event.id; report.streamId = streamId
                report.metrics.streamStartedMs ??= since()
              }
              if (event.type === 'tool') { void requestStop('unexpected_tool'); fail('unexpected_tool') }
              if (event.type === 'text' || event.type === 'reset') {
                const characters = Array.from(event.type === 'text' ? event.delta : event.text).length
                report.streamEvents.textCharacters += characters
                if (report.stop.requested) report.streamEvents.textCharactersAfterStop += characters
                if (characters > 0 && report.metrics.firstTextMs === undefined) {
                  report.metrics.firstTextMs = since()
                  report.metrics.headersToFirstTextMs = milliseconds(report.metrics.firstTextMs - report.metrics.streamHeadersMs)
                  report.firstTextTargetMet = report.metrics.firstTextMs <= 3_000
                  void requestStop('first_visible_text')
                  clearTimeout(deadline)
                  deadline = setTimeout(() => streamController.abort('stop_deadline'), stopTimeoutMs)
                }
              }
              if (event.type === 'committed') {
                report.metrics.committedMs = since(); report.stop.committedObserved = true
                report.committed = { id: event.id, through: event.through, quiet: event.quiet }
              }
              save()
            },
            onRead: evidence => { report.chatReads.push(evidence); save() },
            onClosed: evidence => { report.streamEof = evidence.eof; report.streamClosed = evidence.readerReleased },
          })
          report.stop.termination = completed.termination
          report.replayedRounds = completed.replayedRounds
          const ownItems = completed.chat.items.filter(item => item.streamId === streamId)
          report.afterStop = { cursor: completed.chat.cursor, committedPersisted: completed.chat.persistedStreamIds.includes(completed.committed.id),
            working: completed.chat.working, activeStream: Boolean(completed.chat.streamRunId),
            ownPersistedItems: ownItems.length, stoppedMarker: ownItems.some(item => item.stopped === true),
            stoppedPosition: ownItems.find(item => item.stopped === true && item.position > initial.cursor && item.position <= completed.committed.through)?.position ?? null }
          report.metrics.postStopChatMs = since()
          report.metrics.stopToObservedIdleMs = milliseconds(report.metrics.postStopChatMs - report.metrics.stopRequestedMs)
          report.metrics.streamClosedMs = since()
        } catch (cause) {
          if (streamController.signal.aborted && (cause?.name === 'AbortError' || cause?.message === 'stream_deadline')) {
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
        report.cleanup.status = 'running'
        if (sent) {
          // One stop attempt for this idle-to-owned-message case; no retries and no unrelated pre-existing turn.
          if (!stopPromise) requestStop('error_cleanup')
          await stopPromise
          streamController?.abort()
          if (!completed) {
            report.postStopChatReads++; report.cleanupChatReads++
            try {
              const after = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [botId]))
              report.metrics.postStopChatMs = since()
              if (after.botId !== botId) fail('chat_invalid')
              const ownItems = streamId ? after.items.filter(item => item.streamId === streamId) : []
              report.afterStop = { working: after.working, activeStream: Boolean(after.streamRunId),
                ownPersistedItems: ownItems.length, stoppedMarker: ownItems.some(item => item.stopped === true) }
              if (!after.working && !after.streamRunId) report.metrics.stopToObservedIdleMs = milliseconds(report.metrics.postStopChatMs - report.metrics.stopRequestedMs)
              if (after.working || after.streamRunId) { error ??= new Error('stop_not_quiescent'); report.cleanup.status = 'needs_followup' }
            } catch (cause) { error ??= new Error('post_stop_chat_failed', { cause }); report.cleanup.status = 'needs_followup' }
          }
        }
        if (live) {
          try { report.cleanup.liveClosed = await live.close() } catch { report.cleanup.liveClosed = false }
          if (!report.cleanup.liveClosed) { error ??= new Error('live_close_failed'); report.cleanup.status = 'needs_followup' }
          if (sent && !live.summary.matchingPushes) error ??= new Error('live_push_missing')
        }
        if (report.cleanup.status === 'running') report.cleanup.status = 'complete'
        save()
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
  save(); return report
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'first-text-stop') throw new Error('acceptance_command_invalid')
  const report = await runOrdinaryStop()
  mkdirSync(OUTPUT_DIR, { recursive: true })
  const key = report.fixture?.key === 'luna' ? 'luna' : 'haiku'
  writeFileSync(`${OUTPUT_DIR}/coordinator-ordinary-stop-${key}.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (report.status !== 'observed') process.exitCode = 1
}
