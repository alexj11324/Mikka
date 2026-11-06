// Complete short turns for #1506 prompt-cache/first-text observation.
// Normal owner APIs only. No retry/polling, no fixture/settings changes, no cache verdict.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { alexSession } from '../issue-1506-readonly/alex-session.mjs'
import { FIXTURE_ERRORS, openAcceptanceFixture, verifyOwnModel } from './coordinator-fixtures.mjs'
import { PROTOCOL_SOURCE_SHA, openLiveObserver, readJson, readStream,
  requireExactSha, rpc, validateChat } from '../issue-1504-1506/coordinator-baseline.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUN = /^wrun_[a-zA-Z0-9_-]{1,160}$/
const reference = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
const ms = value => Math.round(value * 10) / 10
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const fail = message => { throw new Error(message) }
const ERRORS = new Set([...FIXTURE_ERRORS,
  'acceptance_sha_required', 'acceptance_version_mismatch', 'acceptance_version_changed',
  'alex_credentials_missing', 'acceptance_identity_mismatch', 'acceptance_deadline_exceeded',
  'acceptance_http_failed', 'acceptance_rpc_failed', 'acceptance_signout_failed',
  'workspace_inventory_invalid', 'workspace_target_missing', 'workspace_switch_failed',
  'chat_invalid', 'chat_not_idle', 'chat_live_scope_invalid', 'model_not_shared_haiku',
  'live_ticket_invalid', 'live_ready_timeout', 'live_connection_failed', 'live_not_supported',
  'send_not_queued', 'stream_status_invalid', 'stream_headers_invalid', 'stream_event_invalid',
  'stream_sequence_invalid', 'stream_turn_mismatch', 'stream_error', 'stream_deadline',
  'first_text_missing', 'committed_missing', 'unexpected_tool', 'reply_too_long', 'reply_missing', 'reply_not_persisted',
  'stop_request_failed', 'stop_not_quiescent', 'post_stop_chat_failed', 'live_close_failed',
  'turn_count_invalid', 'turn_timeout_invalid',
])
const code = error => ERRORS.has(error?.message) ? error.message : 'acceptance_unexpected_failure'
const PROMPTS = [
  '测试验收：不要调用工具、创建任务、查资料或写文件。只回答计算结果，最多30个字：17加25等于多少？',
  '测试验收：不要调用工具、创建任务、查资料或写文件。只用最多30个字回答：标准大气压下，水的沸点是多少摄氏度？',
  '测试验收：不要调用工具、创建任务、查资料或写文件。只用最多30个字回答：一个普通三角形有几条边？',
]
const routes = new Set(['/mikka/api/auth/sign-in/email', '/mikka/api/auth/get-session', '/mikka/api/auth/sign-out',
  '/mikka/api/version', '/mikka/api/workspace/switcher', '/mikka/api/rpc', '/mikka/api/live/ticket', '/mikka/api/coordinator/stream'])
const requestSummary = requests => requests.filter(row => routes.has(row.path)).map(({ path, method, status, headersMs }) => ({
  path, method: method === 'POST' ? 'POST' : 'GET', status: Number.isInteger(status) ? status : null, headersMs: number(headersMs),
}))
const liveCounters = summary => ({ matchingPushes: counter(summary?.matchingPushes),
  versionedPushes: counter(summary?.versionedPushes), newerPushes: counter(summary?.newerPushes) })

export async function runCacheTurns({ env = process.env, sessionProvider = alexSession, openLive = openLiveObserver,
  fixtureReceipt = null, turnTimeoutMs = 60_000, stopTimeoutMs = 20_000, checkpoint = true } = {}) {
  const report = { schemaVersion: 1, issue: 1506, case: 'complete-short-turns', status: 'failed',
    protocolSourceSha: PROTOCOL_SOURCE_SHA, applicationSha: null, startedAt: new Date().toISOString(),
    messageSendAttempts: 0, taskCreationRequests: 0, modelSelectionWrites: 0, turns: [],
    runtimeEvidence: { confirmed: false, required: 'model_call_timing_for_each_workflowRunId',
      cacheReadTokens: 'not_observed', cacheWriteTokens: 'not_observed' },
    cleanup: { status: 'not_started', stopRequired: false, stopRequested: false, liveClosed: false }, requests: [] }
  let requests = []
  const save = () => {
    report.requests = requestSummary(requests)
    if (!checkpoint) return
    mkdirSync('issue-1506-alex-report', { recursive: true })
    const path = `issue-1506-alex-report/coordinator-cache-turns-${report.fixture?.key === 'luna' ? 'luna' : 'haiku'}.json`
    writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(path + '.tmp', path)
  }
  try {
    const expectedSha = requireExactSha(env.MIKKA_ACCEPTANCE_SHA)
    const count = env.MIKKA_CACHE_TURNS === undefined ? 2 : Number(env.MIKKA_CACHE_TURNS)
    if (![2, 3].includes(count) || env.MIKKA_CACHE_TURNS !== undefined && !['2', '3'].includes(env.MIKKA_CACHE_TURNS)) fail('turn_count_invalid')
    if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0 || turnTimeoutMs > 60_000) fail('turn_timeout_invalid')
    report.applicationSha = expectedSha; report.requestedTurns = count
    report.perTurnLimitMs = turnTimeoutMs; report.totalLimitMs = count * turnTimeoutMs + 90_000
    await sessionProvider(async session => {
      requests = session.requests
      if (session.version?.build !== expectedSha) fail('acceptance_version_mismatch')
      const fixture = await openAcceptanceFixture(session, env, fixtureReceipt)
      report.fixture = { key: fixture.fixtureKey, runKey: fixture.fixtureRunKey, botId: fixture.botId }
      report.workspace = { ref: fixture.workspace.ref, kind: 'team', switchedThroughProductAction: true }
      let chat = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [fixture.botId]))
      if (chat.botId !== fixture.botId) fail('fixture_scope_mismatch')
      if (!chat.enabled || chat.working || chat.streamRunId) fail('chat_not_idle')
      const botId = fixture.botId
      report.botRef = fixture.botRef
      report.menu = fixture.menu
      let live, active = null, failure = null
      try {
        live = await openLive(session, chat)
        for (let index = 0; index < count; index++) {
          const turnBegan = performance.now(), controller = new AbortController()
          const timeout = setTimeout(() => controller.abort('turn_deadline'), turnTimeoutMs)
          const row = { index: index + 1, status: 'failed', messageSendAttempted: false, metrics: {},
            streamEvents: { start: 0, text: 0, reset: 0, thinking: 0, tool: 0, committed: 0 },
            replyCharacters: 0, postTurnChatReads: 0, committedObserved: false, confirmedIdle: false }
          report.turns.push(row)
          const previousCounters = liveCounters(live.summary)
          active = { row, controller, sent: false, idle: false, stopPromise: null, start: null }
          const since = () => active.start === null ? null : ms(performance.now() - active.start)
          const stop = () => {
            if (active.stopPromise) return active.stopPromise
            report.cleanup.stopRequired = true; report.cleanup.stopRequested = true
            row.stopRequested = true; row.metrics.stopRequestedMs = since()
            active.stopPromise = rpc(session, 'coordinator.stopCoordinatorTurn', [botId], { timeoutMs: stopTimeoutMs })
              .then(result => { row.stopAcknowledged = result?.stopped === true; return row.stopAcknowledged })
              .catch(error => { row.stopError = code(error); return false })
            return active.stopPromise
          }
          active.stop = stop
          try {
            if ((await readJson(session, '/api/version', { signal: controller.signal })).build !== expectedSha) fail('acceptance_version_changed')
            verifyOwnModel(await rpc(session, 'execution-settings.getBotModelMenu', [botId], { signal: controller.signal }), fixture.menu)
            // begin() resets the observation clock; counters remain cumulative.
            // Reset the reported first-push slot and seen revision for this turn only.
            live.summary.firstPushMs = null
            live.summary.baselineRevision = number(chat.live?.revisions?.['bot_chat:' + botId.toLowerCase()])
            active.start = performance.now(); live.begin(active.start)
            row.sentAt = new Date().toISOString()
            row.messageSendAttempted = true; active.sent = true; report.messageSendAttempts++; save()
            const queued = await rpc(session, 'coordinator.sendCoordinatorMessage', [PROMPTS[index], null, botId, randomUUID()], { signal: controller.signal })
            row.metrics.sendAcknowledgedMs = since()
            if (queued?.queued !== true) fail('send_not_queued')
            row.metrics.streamRequestedMs = since()
            const response = await session.request('/api/coordinator/stream?wait=1&botId=' + botId, { signal: controller.signal })
            row.metrics.streamHeadersMs = since(); row.streamStatus = response.status
            if (response.status !== 200) { await response.body?.cancel(); fail('stream_status_invalid') }
            const runId = response.headers.get('x-mikka-stream-run')
            if (!RUN.test(runId ?? '') || !response.headers.get('content-type')?.startsWith('application/x-ndjson') ||
              !response.headers.get('x-mikka-stream-key') || !response.body) {
              await response.body?.cancel(); fail('stream_headers_invalid')
            }
            row.workflowRunId = runId; save()
            let streamId = null
            row.termination = await readStream(response.body, event => {
              if (!event.id.startsWith(runId + ':')) fail('stream_turn_mismatch')
              row.streamEvents[event.type]++
              if (event.type === 'start') {
                if (streamId) fail('stream_turn_mismatch')
                streamId = event.id; row.metrics.streamStartedMs = since()
              }
              if (!streamId || event.id !== streamId) fail('stream_turn_mismatch')
              if (event.type === 'tool') { void stop(); fail('unexpected_tool') }
              if (event.type === 'text' || event.type === 'reset') {
                const characters = Array.from(event.text).length
                row.replyCharacters = event.type === 'reset' ? characters : row.replyCharacters + characters
                if (characters && row.metrics.firstTextMs === undefined) {
                  row.metrics.firstTextMs = since()
                  row.metrics.headersToFirstTextMs = ms(row.metrics.firstTextMs - row.metrics.streamHeadersMs)
                  row.firstTextTargetMet = row.metrics.firstTextMs <= 3_000
                }
              }
              if (event.type === 'committed') { row.committedObserved = true; row.metrics.committedMs = since() }
              // A committed reply precedes releaseLease. Continue to bounded EOF;
              // only then does the one normal chat read check idle.
              return false
            }, controller.signal)
            row.metrics.streamClosedMs = since(); row.streamClosed = true
            if (row.termination !== 'eof') fail('stream_deadline')
            row.postTurnChatReads++
            chat = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [botId], { signal: controller.signal }))
            row.metrics.chatObservedMs = since()
            if (chat.botId !== botId) fail('chat_invalid')
            row.afterTurn = { working: chat.working, activeStream: Boolean(chat.streamRunId),
              ownPersistedItems: chat.items.filter(item => item.streamId === streamId).length }
            active.idle = !chat.working && !chat.streamRunId; row.confirmedIdle = active.idle
            if (!active.idle) fail('chat_not_idle')
            if (row.metrics.firstTextMs === undefined) fail('first_text_missing')
            if (!row.committedObserved) fail('committed_missing')
            if (row.replyCharacters === 0) fail('reply_missing')
            if (row.afterTurn.ownPersistedItems === 0) fail('reply_not_persisted')
            if (row.replyCharacters > 30) fail('reply_too_long')
            row.status = 'observed'; row.metrics.sendToIdleMs = since()
          } catch (error) {
            row.error = controller.signal.aborted ? 'stream_deadline' : code(error)
            throw new Error(row.error, { cause: error })
          } finally {
            clearTimeout(timeout); controller.abort(); row.streamClosed = true
            const current = liveCounters(live.summary)
            row.live = { baselineRevision: number(live.summary.baselineRevision),
              matchingPushes: current.matchingPushes - previousCounters.matchingPushes,
              versionedPushes: current.versionedPushes - previousCounters.versionedPushes,
              newerPushes: current.newerPushes - previousCounters.newerPushes,
              firstPushMs: number(live.summary.firstPushMs), maxRevision: number(live.summary.maxRevision) }
            row.durationMs = ms(performance.now() - turnBegan); save()
          }
        }
        if ((await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
        report.applicationVersionStable = true
      } catch (error) { failure = error }
      finally {
        report.cleanup.status = 'running'
        if (active?.sent && !active.idle) {
          const acknowledged = await active.stop()
          report.cleanup.stopAcknowledged = acknowledged
          active.controller.abort()
          // At most one post-turn chat read. If the one after EOF already found
          // activity, record pending cleanup rather than read repeatedly to pass.
          if (active.row.postTurnChatReads === 0) {
            active.row.postTurnChatReads++
            try {
              const after = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [botId]))
              if (after.botId !== botId) fail('chat_invalid')
              active.idle = !after.working && !after.streamRunId
              active.row.afterCleanup = { working: after.working, activeStream: Boolean(after.streamRunId) }
            } catch (error) { report.cleanup.chatError = code(error) }
          }
          report.cleanup.idleVerified = active.idle
          if (!acknowledged && !active.idle) failure ??= new Error('stop_request_failed')
          if (!active.idle) report.cleanup.status = 'needs_followup'
        }
        if (live) {
          try { report.cleanup.liveClosed = await live.close() }
          catch (error) { report.cleanup.liveError = code(error) }
          report.live = { ready: live.summary.ready === true, revisionCapable: live.summary.revisionCapable === true,
            ...liveCounters(live.summary), unexpectedDisconnect: live.summary.unexpectedDisconnect === true, closed: live.summary.closed === true }
          if (!report.cleanup.liveClosed) { failure ??= new Error('live_close_failed'); report.cleanup.status = 'needs_followup' }
        }
        if (report.cleanup.status === 'running') report.cleanup.status = 'complete'
        save()
      }
      if (failure) throw failure
      report.status = 'observed'
    }, { expectedSha, deadlineAt: Date.now() + report.totalLimitMs })
    if (!requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; report.error = code(error) }
  report.signedOut = requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  report.completedTurns = report.turns.filter(row => row.status === 'observed').length
  const warm = report.turns.slice(1)
  report.warmSamples = warm.filter(row => row.status === 'observed').length
  report.warmFirstTextTargetMet = warm.length > 0 && warm.every(row => row.status === 'observed' && row.firstTextTargetMet)
  report.finishedAt = new Date().toISOString(); save(); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'complete-turns') {
    const report = await runCacheTurns()
    console.log(JSON.stringify(report))
    if (report.status !== 'observed') process.exitCode = 1
  } else {
    console.log('Usage: node coordinator-cache-turns.mjs complete-turns')
    console.log('Requires exact MIKKA_ACCEPTANCE_SHA and normal ACME credentials plus a ready fixture receipt and MIKKA_FIXTURE_KIND; MIKKA_CACHE_TURNS is 2 (default) or 3.')
  }
}
