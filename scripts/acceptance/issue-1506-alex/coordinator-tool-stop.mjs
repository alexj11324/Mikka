// Observe a real, read-only web_search tool boundary for #1490 / #1506.
// Public "running" is a model tool-call, not proof of execute-enter. Runtime
// ordering must be verified separately from real server logs/audit records.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { alexSession } from '../issue-1506-readonly/alex-session.mjs'
import { FIXTURE_ERRORS, openAcceptanceFixture } from './coordinator-fixtures.mjs'
import { readJson,
  requireExactSha, rpc, validateChat } from '../issue-1504-1506/coordinator-baseline.mjs'
import { CACHE_PROTOCOL_SOURCE_SHA, openCacheLive, observeStoppedCompletion } from './coordinator-cache-completion.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUN = /^wrun_[a-zA-Z0-9_-]{1,160}$/
export const DURING_TOOL_DELAY_MS = 600
const reference = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
const ms = value => Math.round(value * 10) / 10
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const fail = name => { throw new Error(name) }
const ERRORS = new Set([...FIXTURE_ERRORS,
  'acceptance_sha_required', 'acceptance_version_mismatch', 'acceptance_version_changed',
  'alex_credentials_missing', 'acceptance_identity_mismatch', 'acceptance_deadline_exceeded',
  'acceptance_http_failed', 'acceptance_rpc_failed', 'acceptance_signout_failed',
  'workspace_inventory_invalid', 'workspace_target_missing', 'workspace_switch_failed',
  'chat_invalid', 'chat_not_idle', 'chat_live_scope_invalid', 'model_not_shared_haiku',
  'live_ticket_invalid', 'live_ready_timeout', 'live_connection_failed', 'live_not_supported',
  'send_not_queued', 'stream_status_invalid', 'stream_headers_invalid', 'stream_event_invalid',
  'stream_sequence_invalid', 'stream_turn_mismatch', 'stream_error', 'stream_deadline',
  'unexpected_tool', 'tool_boundary_not_observed', 'stop_not_acknowledged', 'stop_not_quiescent',
  'post_stop_chat_failed', 'live_close_failed', 'case_invalid', 'timeout_invalid',
  'committed_invalid', 'stream_incomplete', 'chat_completion_error', 'reply_failed_or_stopped',
  'chat_revision_stale', 'stream_replay_unproven', 'reply_not_persisted',
])
const code = error => ERRORS.has(error?.message) ? error.message : 'acceptance_unexpected_failure'

export async function runToolStop({ env = process.env, sessionProvider = alexSession, openLive = openCacheLive,
  fixtureReceipt = null, streamTimeoutMs = 60_000, stopTimeoutMs = 20_000, checkpoint = true } = {}) {
  const report = { schemaVersion: 1, issue: 1506, case: 'real-web-search-tool-call-stop', sampleId: randomUUID(), status: 'failed',
    protocolSourceSha: CACHE_PROTOCOL_SOURCE_SHA, applicationSha: null, startedAt: new Date().toISOString(),
    messageSendAttempts: 0, taskCreationRequests: 0, modelSelectionWrites: 0, postStopChatReads: 0, completionChatReads: 0, cleanupChatReads: 0, chatReads: [],
    metrics: {}, tools: [], stop: { requested: false, acknowledged: false },
    runtimeBoundary: { classification: 'unverified', executeEntered: 'not_observed',
      required: 'same_build_workflowRunId_callRef_real_tool_start_finish_and_stop_ordering' },
    cleanup: { status: 'not_started', liveClosed: false } }
  let requests = [], sessionDiagnostics
  const save = () => {
    if (!checkpoint) return
    mkdirSync('issue-1506-alex-report', { recursive: true })
    writeFileSync(`issue-1506-alex-report/coordinator-tool-stop-${report.fixtureKey ?? 'unselected'}-${report.requestedCase ?? 'unselected'}-${report.sampleId}.json`, JSON.stringify(report, null, 2) + '\n')
  }
  try {
    const expectedSha = requireExactSha(env.MIKKA_ACCEPTANCE_SHA)
    const fixtureKey = env.MIKKA_FIXTURE_KIND
    if (fixtureKey !== undefined && !['haiku', 'luna'].includes(fixtureKey)) fail('fixture_key_invalid')
    report.fixtureKey = fixtureKey ?? 'unselected'
    const requestedCase = env.MIKKA_STOP_CASE ?? 'observe'
    if (!['observe', 'before_tool', 'during_tool'].includes(requestedCase)) fail('case_invalid')
    if (!(streamTimeoutMs > 0 && streamTimeoutMs <= 60_000 && stopTimeoutMs > 0 && stopTimeoutMs <= 20_000)) fail('timeout_invalid')
    report.applicationSha = expectedSha; report.requestedCase = requestedCase
    report.sample = { attempts: 1, plannedDelayMs: requestedCase === 'during_tool' ? DURING_TOOL_DELAY_MS : 0,
      classification: 'pending_server_timing_and_final_audit', countedEvenIfBoundaryMissed: true }
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
      let live, controller, stopPromise = null, sent = false, streamId = null, failure = null, completed = null, lastObservedChat = null, naturalIdleConfirmed = false, started = null
      let delayedStop = null, delayTimer = null, settleDelayedStop = null
      const since = () => started === null ? null : ms(performance.now() - started)
      const stop = trigger => {
        if (stopPromise) return stopPromise
        report.stop.requested = true; report.stop.trigger = trigger; report.metrics.stopRequestedMs = since()
        report.stop.requestedAt = Date.now()
        stopPromise = rpc(session, 'coordinator.stopCoordinatorTurn', [botId], { timeoutMs: stopTimeoutMs })
          .then(value => { report.stop.acknowledged = value?.stopped === true; report.metrics.stopAcknowledgedMs = since();
            report.stop.acknowledgedAt = Date.now(); return report.stop.acknowledged })
          .catch(error => { report.stop.error = code(error); return false })
        save()
        return stopPromise
      }
      try {
        live = await openLive(session, initial)
        if ((await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
        started = performance.now(); report.sentAt = new Date().toISOString(); live.begin(started)
        const searchQuery = requestedCase === 'during_tool'
          ? 'PostgreSQL 官网最新一次小版本发布公告的标题和发布日期'
          : 'Node.js 官网最新一篇安全发布公告的标题和发布日期'
        const prompt = `请在本轮实际调用一次 web_search，查询“${searchQuery}”，搜索 limit=1。必须根据这次搜索结果回答，不复用之前的搜索结果或聊天答案。只读公开网页，不用其他工具，不创建任务、不写文件、不联系任何人。搜索返回后只用一句话和官方链接回答。`
        sent = true; report.messageSendAttempts++; save()
        const queued = await rpc(session, 'coordinator.sendCoordinatorMessage', [prompt, null, botId, randomUUID()])
        report.metrics.sendAcknowledgedMs = since()
        if (queued?.queued !== true) fail('send_not_queued')
        controller = new AbortController()
        let deadline = setTimeout(() => controller.abort('stream_deadline'), streamTimeoutMs)
        try {
          report.metrics.streamRequestedMs = since()
          const response = await session.request('/api/coordinator/stream?wait=1&botId=' + botId, { signal: controller.signal })
          report.metrics.streamHeadersMs = since(); report.streamStatus = response.status
          if (response.status !== 200) { await response.body?.cancel(); fail('stream_status_invalid') }
          const runId = response.headers.get('x-mikka-stream-run')
          if (!RUN.test(runId ?? '') || !response.headers.get('content-type')?.startsWith('application/x-ndjson') ||
            !response.headers.get('x-mikka-stream-key') || !response.body) { await response.body?.cancel(); fail('stream_headers_invalid') }
          report.workflowRunId = runId; save()
          completed = await observeStoppedCompletion({ body: response.body, runId, botId,
            initialChat: initial, live, signal: controller.signal,
            readChat: async signal => {
              report.completionChatReads++; report.postStopChatReads++
              lastObservedChat = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [botId], { signal }))
              return lastObservedChat
            },
            onEvent: (event, _rounds, sequence) => {
              if (event.type === 'start') { streamId = event.id; report.streamId = event.id; report.metrics.streamStartedMs = since() }
              if ((event.type === 'text' ? event.delta : event.type === 'reset' ? event.text : '').length) report.metrics.firstTextMs ??= since()
              if (event.type === 'tool') {
                const tool = event.name === 'web_search' ? 'web_search' : 'unexpected', callRef = reference(event.call)
                const observation = { tool, callRef, state: event.state,
                  sequence, observedMs: since(), afterStopRequest: report.stop.requested }
                report.tools.push(observation)
                if (tool !== 'web_search') { void stop('unexpected_tool'); fail('unexpected_tool') }
                if (event.state === 'running' && !report.triggerCallRef && !report.stop.requested) {
                  report.triggerCallRef = callRef; report.metrics.toolCallObservedMs = observation.observedMs
                  const stopAtBoundary = () => {
                    report.metrics.delayAfterToolCallMs = ms(since() - observation.observedMs)
                    const stopped = stop(requestedCase === 'during_tool' ? 'public_web_search_running_after_fixed_delay' : 'public_web_search_running')
                    clearTimeout(deadline); deadline = setTimeout(() => controller.abort('stop_deadline'), stopTimeoutMs)
                    return stopped
                  }
                  if (requestedCase === 'during_tool') {
                    // One client-side sample delay, never product polling or proof
                    // that execution entered. Server intervals classify the result.
                    delayedStop = new Promise(resolve => {
                      settleDelayedStop = resolve
                      delayTimer = setTimeout(() => { delayTimer = null; resolve(stopAtBoundary()) }, DURING_TOOL_DELAY_MS)
                    })
                  } else void stopAtBoundary()
                }
              }
              if (event.type === 'committed') {
                report.committedObserved = true; report.metrics.committedMs = since()
                report.committed = { id: event.id, through: event.through, quiet: event.quiet }
              }
              save()
            },
            onRead: evidence => { report.chatReads.push(evidence); save() },
            onClosed: evidence => { report.streamEof = evidence.eof; report.streamClosed = evidence.readerReleased },
          })
          report.termination = completed.termination; report.replayedRounds = completed.replayedRounds
          const own = completed.chat.items.filter(item => item.streamId === streamId)
          report.afterStop = { cursor: completed.chat.cursor, committedPersisted: completed.chat.persistedStreamIds.includes(completed.committed.id),
            working: completed.chat.working, activeStream: Boolean(completed.chat.streamRunId),
            ownPersistedItems: own.length, stoppedMarker: own.some(item => item.stopped === true),
            stoppedPosition: own.find(item => item.stopped === true && item.position > initial.cursor && item.position <= completed.committed.through)?.position ?? null }
          report.metrics.postStopChatMs = since()
          report.metrics.stopToObservedIdleMs = ms(report.metrics.postStopChatMs - report.metrics.stopRequestedMs)
          report.metrics.streamClosedMs = since()
          if (!report.triggerCallRef) fail('tool_boundary_not_observed')
          if (!await (stopPromise ?? delayedStop)) fail('stop_not_acknowledged')
        } catch (error) {
          // A natural reply has no stopped marker. Reclassify only after this
          // same new committed round is durably present and its lease is idle.
          // The strict shared helper and all actual Stop predicates stay intact.
          const chat = lastObservedChat, commit = report.committed
          const own = chat?.items.filter(item => item.streamId === streamId) ?? []
          if (error?.message === 'reply_not_persisted' && report.tools.length === 0 &&
            !report.triggerCallRef && !report.stop.requested && commit?.id === streamId &&
            commit?.quiet === false && Number.isSafeInteger(commit?.through) && commit.through > initial.cursor &&
            !initial.persistedStreamIds.includes(commit.id) &&
            chat?.botId === botId && chat.enabled && chat.error === null && !chat.working && !chat.streamRunId &&
            chat.cursor >= commit.through && chat.persistedStreamIds.includes(commit.id) &&
            chat.live?.ownerId === initial.live?.ownerId && chat.live?.workspaceId === initial.live?.workspaceId &&
            Number.isSafeInteger(chat.live?.revisions?.['bot_chat:' + botId.toLowerCase()]) &&
            chat.live.revisions['bot_chat:' + botId.toLowerCase()] >= live.revision &&
            !own.some(item => item.stopped || item.failure) &&
            own.some(item => item.from === 'coordinator' && !item.pending && typeof item.text === 'string' &&
              item.text.length > 0 && Number.isSafeInteger(item.position) &&
              item.position > initial.cursor && item.position <= commit.through)) {
            naturalIdleConfirmed = true
            completed = { chat, committed: commit }
            report.termination = report.streamEof ? 'eof' : 'client_cancel_after_natural_committed_idle'
            report.afterStop = { cursor: chat.cursor, committedPersisted: true, working: false, activeStream: false,
              ownPersistedItems: own.length, stoppedMarker: false, stoppedPosition: null }
            report.sample.classification = 'tool_boundary_not_observed'
            report.runtimeBoundary.classification = 'not_covered'
            fail('tool_boundary_not_observed')
          }
          if (controller.signal.aborted && error?.name === 'AbortError') fail('stream_deadline')
          throw error
        }
        finally { clearTimeout(deadline); controller.abort(); report.streamClosed = true; report.metrics.streamClosedMs ??= since() }
      } catch (error) { failure = error }
      finally {
        report.cleanup.status = 'running'
        if (delayTimer !== null) {
          clearTimeout(delayTimer); delayTimer = null; settleDelayedStop?.(false)
          report.sample.delayCancelledByFailure = true
        }
        if (sent) {
          if (!stopPromise && !naturalIdleConfirmed) void stop('error_cleanup')
          if (naturalIdleConfirmed) report.cleanup.stopSkippedBecause = 'natural_completion_confirmed_idle'
          await stopPromise; controller?.abort()
          if (!completed) {
            report.postStopChatReads++; report.cleanupChatReads++
            try {
              const after = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [botId]))
              if (after.botId !== botId) fail('chat_invalid')
              const own = streamId ? after.items.filter(item => item.streamId === streamId) : []
              report.afterStop = { working: after.working, activeStream: Boolean(after.streamRunId),
                ownPersistedItems: own.length, stoppedMarker: own.some(item => item.stopped === true) }
              if (after.working || after.streamRunId) { failure ??= new Error('stop_not_quiescent'); report.cleanup.status = 'needs_followup' }
            } catch (error) { failure ??= new Error('post_stop_chat_failed'); report.cleanup.status = 'needs_followup' }
          }
        }
        if (live) {
          try { report.cleanup.liveClosed = await live.close() }
          catch { report.cleanup.liveClosed = false }
          report.live = { ready: live.summary.ready === true, matchingPushes: number(live.summary.matchingPushes),
            versionedPushes: number(live.summary.versionedPushes), newerPushes: number(live.summary.newerPushes),
            firstPushMs: number(live.summary.firstPushMs), unexpectedDisconnect: live.summary.unexpectedDisconnect === true }
          if (!report.cleanup.liveClosed) { failure ??= new Error('live_close_failed'); report.cleanup.status = 'needs_followup' }
        }
        if (report.cleanup.status === 'running') report.cleanup.status = 'complete'
        save()
      }
      if (failure) throw failure
      if ((await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
      report.applicationVersionStable = true; report.status = 'observed'
    }, { expectedSha, deadlineAt: Date.now() + 180_000,
      onSession: value => { sessionDiagnostics = value; requests = value.requests } })
    if (sessionDiagnostics ? !sessionDiagnostics.signOut.succeeded : !requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; report.error = code(error) }
  const routes = new Set(['/mikka/api/auth/sign-in/email', '/mikka/api/auth/get-session', '/mikka/api/auth/sign-out',
    '/mikka/api/version', '/mikka/api/workspace/switcher', '/mikka/api/rpc', '/mikka/api/live/ticket', '/mikka/api/coordinator/stream'])
  report.requests = requests.filter(row => routes.has(row.path)).map(({ path, method, status, headersMs }) => ({
    path, method: method === 'POST' ? 'POST' : 'GET', status: Number.isInteger(status) ? status : null, headersMs: number(headersMs),
  }))
  if (sessionDiagnostics) report.sessionSignOut = { ...sessionDiagnostics.signOut }
  report.signedOut = sessionDiagnostics ? sessionDiagnostics.signOut.succeeded : requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  report.publicRunningCallCount = new Set(report.tools.filter(row => row.state === 'running').map(row => row.callRef)).size
  report.finishedAt = new Date().toISOString(); save(); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'tool-call-stop') {
    const report = await runToolStop(); console.log(JSON.stringify(report))
    if (report.status !== 'observed') process.exitCode = 1
  } else {
    console.log('Usage: node coordinator-tool-stop.mjs tool-call-stop')
    console.log('Requires exact MIKKA_ACCEPTANCE_SHA and normal ACME credentials plus a ready fixture receipt and MIKKA_FIXTURE_KIND; MIKKA_STOP_CASE=observe|before_tool stops at the public tool-call; during_tool waits once for 600ms. Actual classification requires matching server timing and final audit; every sample is retained.')
  }
}
