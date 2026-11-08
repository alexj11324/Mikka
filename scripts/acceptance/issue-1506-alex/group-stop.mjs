// A new, private-to-this-test group only: the ACME owner and the two receipt bots.
// Group replies have no public token stream. Observe real group_chat revisions,
// then use the normal Stop API and one post-stop state + decision-trace read.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ALEX_OWNER_ID, alexSession } from '../issue-1506-readonly/alex-session.mjs'
import { readJson, requireExactSha, rpc } from '../issue-1504-1506/coordinator-baseline.mjs'
import { OUTPUT_DIR, UUID, ref, selectOwnedWorkspace } from './workspace-setup.mjs'
import { loadFixtureReceipt, openAcceptanceFixture, validateFixtureReceipt, verifyOwnedFixture, verifyOwnModel, FIXTURE_ERRORS } from './coordinator-fixtures.mjs'
import { openGroupLive } from './group-live.mjs'

const PROMPT = '测试群停止：这是一条临时验收消息。被提及的 Bot 只从 1 连续数到 600，用空格分隔，直接开始。不要创建任务、调用工具、私聊、请求其他成员回复、写文件或访问外部服务。'
const BOUNDARIES = ['after_send', 'responding_bot', 'private_generation_receipt']
const fixed = (value, values) => values.includes(value) ? value : 'unknown'
const fail = code => { throw new Error(code) }
const ERRORS = new Set([...FIXTURE_ERRORS, 'acceptance_http_failed', 'acceptance_rpc_failed', 'acceptance_signout_failed', 'acceptance_deadline_exceeded', 'group_receipt_invalid', 'group_scope_mismatch', 'group_member_mismatch',
  'group_exists', 'group_create_unknown', 'group_not_empty', 'group_send_unknown', 'group_message_invalid',
  'group_state_invalid', 'group_stop_not_observed', 'group_boundary_timeout', 'group_read_limit', 'group_boundary_missed',
  'group_cleanup_pending', 'group_trace_mismatch', 'group_unexpected_delegation', 'group_private_generation_not_observed', 'group_live_scope_invalid',
  'group_live_wait_invalid', 'live_ticket_invalid', 'live_ready_timeout', 'live_connection_failed', 'live_not_supported', 'live_close_failed'])
const safeError = error => ERRORS.has(error?.message) ? error.message : 'group_acceptance_failed'
export const groupName = report => `测试 Issue1506 group-stop ${report.scenario ?? 'public'} ${report.fixtureRunKey} ${report.fixtureKey} ${report.boundary} ${report.applicationSha.slice(0, 8)}`

// This response header is a candidate correlation key, not a proven Vercel
// runtime requestId. Never retain headers, request bodies or arbitrary text.
export function groupRequestMetadata({ path, method, status, headersMs, requestId }) {
  return { path, method, status, headersMs, requestId: typeof requestId === 'string' && requestId.length <= 200 &&
    /^(?:[a-z0-9]{3,12}::){1,5}[A-Za-z0-9_-]{5,160}$/.test(requestId) ? requestId : null }
}

export function validateGroupReceipt(value, fixtures) {
  if (value?.schemaVersion !== 1 || value.issue !== 1506 || value.phase !== 'alex-group-stop' ||
    value.ownerRef !== ref(ALEX_OWNER_ID) || value.workspaceId !== fixtures.workspace.id ||
    value.fixtureRunKey !== fixtures.runKey || !fixtures.fixtures.some(row => row.key === value.fixtureKey) ||
    !BOUNDARIES.includes(value.boundary) || !['public', 'private'].includes(value.scenario ?? 'public') ||
    ((value.scenario ?? 'public') === 'private') !== (value.boundary === 'private_generation_receipt') || !/^[0-9a-f]{40}$/.test(value.applicationSha ?? '') ||
    value.groupId !== null && !UUID.test(value.groupId ?? '') || value.messageId !== null && !UUID.test(value.messageId ?? '')) fail('group_receipt_invalid')
  return value
}

async function api(session, path, { body, method, timeoutMs = 20_000 } = {}) {
  const response = await session.request(path, { body, method, signal: AbortSignal.timeout(Math.ceil(timeoutMs)) })
  const value = await response.json().catch(() => null)
  if (!response.ok || value?.error) fail('acceptance_http_failed')
  return value
}

export function validateGroupMembers(value, botIds, { allowRemovedBots = false } = {}) {
  if (!Array.isArray(value?.members)) fail('group_member_mismatch')
  const users = value.members.filter(member => member.memberType === 'user')
  const bots = value.members.filter(member => member.memberType === 'bot')
  if (users.length !== 1 || users[0].id !== ALEX_OWNER_ID || users[0].role !== 'owner' ||
    users.length + bots.length !== value.members.length || new Set(bots.map(bot => bot.id)).size !== bots.length ||
    bots.some(bot => !botIds.includes(bot.id)) || !allowRemovedBots && (bots.length !== botIds.length || botIds.some(id => !bots.some(bot => bot.id === id)))) fail('group_member_mismatch')
  return bots.map(bot => bot.id)
}

function stateMetadata(value, botIds) {
  if (!Array.isArray(value?.messages) || value.messages.length > 100 || value.agentStatus !== null &&
    (!value.agentStatus || !['queued', 'running'].includes(value.agentStatus.status))) fail('group_state_invalid')
  if (value.agentStatus?.agentId || value.agentStatus?.botId && !botIds.includes(value.agentStatus.botId)) fail('group_scope_mismatch')
  return { revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 0,
    active: value.agentStatus !== null, status: value.agentStatus ? value.agentStatus.status : 'idle',
    respondingBotId: value.agentStatus?.botId ?? null, stopped: value.stopped === true,
    messageCount: value.messages.length, botReplyCount: value.messages.filter(message => message.authorType === 'bot').length }
}

function privateExchange(value, root, botIds) {
  const links = Array.isArray(value?.timeline) ? value.timeline.filter(item => item.type === 'agent_exchange' &&
    String(item.anchorPosition) === String(root.position)) : []
  if (links.length !== 1) return null
  const link = links[0], participants = link.participants
  if (!UUID.test(link.linkId ?? '') || Number(link.count) !== 1 || !Array.isArray(participants) || participants.length !== 2 ||
    participants.some(item => item.memberType !== 'bot' || !botIds.includes(item.id)) ||
    new Set(participants.map(item => item.id)).size !== 2) return null
  return { linkId: link.linkId, privateMessagesBeforeStop: 1 }
}

export function privateGenerationReceipt(trace, messageId, leadBotId, targetBotId) {
  const turn = Array.isArray(trace?.turns) ? trace.turns.find(row => row.messageId === messageId) : null
  const events = Array.isArray(turn?.trace?.events) ? turn.trace.events : []
  const publishAt = events.findIndex(row => row.type === 'private_publish' && row.memberId === leadBotId)
  const targetAt = events.findIndex((row, index) => index > publishAt && row.type === 'generate' && row.memberId === targetBotId)
  if (!turn || turn.status !== 'running' || turn.error || turn.trace?.status !== 'pending' || publishAt < 0 || targetAt <= publishAt ||
    events.filter(row => row.type === 'private_publish').length !== 1 ||
    events.some(row => ['publish', 'delegate'].includes(row.type)) ||
    events.slice(targetAt + 1).some(row => ['generate', 'silent', 'private_publish', 'publish'].includes(row.type))) fail('group_private_generation_not_observed')
  return { privatePublishes: 1, publicPublishes: 0, targetGenerateRecorded: true, targetBotId,
    boundary: 'host_private_generate_receipt', providerInFlight: 'requires_start_end_log_correlation' }
}

export async function runGroupStop({ env = process.env, mode = 'observe', groupReceipt: suppliedGroup = null,
  fixtureReceipt: suppliedFixtures = null, sessionProvider = alexSession, openLive = openGroupLive, checkpoint = true,
  boundaryTimeoutMs = 60_000, maxLiveReads = 8 } = {}) {
  const fixtures = suppliedFixtures ? validateFixtureReceipt(suppliedFixtures, { ready: true })
    : loadFixtureReceipt(env.MIKKA_FIXTURE_RECEIPT, { ready: true })
  if (!['observe', 'cleanup'].includes(mode) || mode === 'cleanup' && !suppliedGroup) fail('group_receipt_invalid')
  const previous = suppliedGroup ? validateGroupReceipt(suppliedGroup, fixtures) : null
  const expectedSha = mode === 'cleanup' ? null : requireExactSha(env.MIKKA_ACCEPTANCE_SHA)
  const key = previous?.fixtureKey ?? env.MIKKA_FIXTURE_KIND
  const selected = fixtures.fixtures.find(row => row.key === key)
  const scenario = previous?.scenario ?? env.MIKKA_GROUP_STOP_SCENARIO ?? 'public'
  const boundary = previous?.boundary ?? (scenario === 'private' ? 'private_generation_receipt' : env.MIKKA_GROUP_STOP_BOUNDARY ?? 'responding_bot')
  const lead = scenario === 'private' ? fixtures.fixtures.find(row => row.key !== key) : selected
  if (!selected || !lead || !['public', 'private'].includes(scenario) || !BOUNDARIES.includes(boundary) ||
    (scenario === 'private') !== (boundary === 'private_generation_receipt') || !(boundaryTimeoutMs > 0 && boundaryTimeoutMs <= 60_000) ||
    !Number.isSafeInteger(maxLiveReads) || maxLiveReads < 1 || maxLiveReads > 8) fail('group_receipt_invalid')
  const began = Date.now()
  const report = previous ? structuredClone(previous) : { schemaVersion: 1, issue: 1506, phase: 'alex-group-stop',
    applicationSha: expectedSha, ownerRef: ref(ALEX_OWNER_ID), workspaceId: fixtures.workspace.id,
    fixtureRunKey: fixtures.runKey, fixtureKey: key, scenario, boundary, groupId: null, messageId: null,
    createAttempted: false, messageSendAttempts: 0 }
  delete report.error
  Object.assign(report, { mode, status: 'failed', startedAt: new Date(began).toISOString(),
    stop: { requested: false, acknowledged: false }, metrics: {}, liveReads: [], postStopReads: 0,
    runtimeCancellation: 'pending_provider_logs', lateSideEffects: 'pending_provider_terminal_and_one_database_audit',
    cleanup: { status: 'not_started', removedBotIds: [], hidden: false }, requests: [] })
  const output = `${OUTPUT_DIR}/group-stop-${key}-${boundary}-${report.applicationSha.slice(0, 8)}${mode === 'cleanup' ? '-cleanup' : ''}.json`
  const botIds = fixtures.fixtures.map(row => row.botId)
  const prompt = scenario === 'private'
    ? `测试私聊停止：这是本临时群中的合成计数交流，不是执行任务。被提及的 Bot 请仅向当前另一测试 Bot ${selected.botId} 私下发送一句“请在私聊中从1逐个数到600，用空格分隔”，设置 privateTo 为该 Bot 的 ID。第一条 text 保持一句话，mentions 只允许该对方。对方收到 privatePeer 后只在这次测试私聊中连续数数，privateTo 指向该测试 peer。不要在公开群回复内容，不要创建任务、调用工具、查询真实信息、写文件或联系其他人。`
    : PROMPT
  let requests = [], sessionDiagnostics
  const save = () => {
    report.requests = requests.map(groupRequestMetadata)
    if (!checkpoint) return
    mkdirSync(OUTPUT_DIR, { recursive: true }); writeFileSync(output + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(output + '.tmp', output)
  }
  try {
    await sessionProvider(async session => {
      requests = session.requests
      if (session.identity?.userId !== ALEX_OWNER_ID) fail('acceptance_identity_mismatch')
      if (expectedSha && session.version?.build !== expectedSha) fail('acceptance_version_mismatch')
      await selectOwnedWorkspace(session, fixtures)
      const bots = await readJson(session, '/api/bots')
      for (const row of fixtures.fixtures) {
        const matches = Array.isArray(bots) ? bots.filter(bot => bot.id === row.botId) : []
        if (matches.length !== 1) fail('fixture_missing')
        verifyOwnedFixture(matches[0], fixtures, row)
        if (mode !== 'cleanup') verifyOwnModel(await rpc(session, 'execution-settings.getBotModelMenu', [row.botId]), row)
      }
      const discover = async () => {
        const list = await api(session, '/api/conversations?workspaceId=' + fixtures.workspace.id)
        if (list?.viewerId !== ALEX_OWNER_ID || list.workspaceId !== fixtures.workspace.id || !Array.isArray(list.conversations)) fail('group_scope_mismatch')
        const matches = list.conversations.filter(group => group.title === groupName(report))
        if (matches.length > 1) fail('group_scope_mismatch')
        const group = matches[0]
        if (group && (!UUID.test(group.id ?? '') || group.kind !== 'group' || group.createdBy !== ALEX_OWNER_ID ||
          group.workspaceId !== fixtures.workspace.id || report.groupId && group.id !== report.groupId)) fail('group_scope_mismatch')
        return group ?? null
      }
      let group = await discover()
      if (mode === 'observe' && group) fail('group_exists')
      if (!group && mode === 'cleanup') fail('group_scope_mismatch')
      if (!group) {
        report.createAttempted = true; save()
        try {
          const created = await api(session, '/api/conversations', { body: { workspaceId: fixtures.workspace.id, title: groupName(report),
            members: botIds.map(memberId => ({ memberType: 'bot', memberId })), leadBotId: lead.botId } })
          if (!UUID.test(created?.id ?? '') || created.title !== groupName(report) || created.leadBotId !== lead.botId) fail('group_create_unknown')
          report.groupId = created.id; save()
        } catch { report.creationOutcome = 'unknown_no_retry' }
        group = await discover()
        if (!group) fail('group_create_unknown')
        report.groupId = group.id; report.creationOutcome ??= 'acknowledged'; save()
      }
      report.groupId = group.id
      const currentMembers = await api(session, `/api/conversations/${group.id}/members`)
      const presentBotIds = validateGroupMembers(currentMembers, botIds, { allowRemovedBots: mode === 'cleanup' })
      const initialRaw = await api(session, `/api/conversations/${group.id}/messages?limit=20`)
      const initial = stateMetadata(initialRaw, botIds)
      if (mode !== 'cleanup' && (initial.active || initial.messageCount !== 0 || initialRaw.leadBotId !== lead.botId)) fail('group_not_empty')
      let live = null, sent = mode === 'cleanup', stopPromise = null, lastState = initial, failure = null, clock = performance.now()
      const since = () => Math.round((performance.now() - clock) * 10) / 10
      const stop = trigger => {
        if (stopPromise) return stopPromise
        report.stop.requested = true; report.stop.trigger = trigger; report.metrics.stopRequestedMs = since(); save()
        stopPromise = api(session, `/api/conversations/${group.id}/stop`, { body: {} })
          .then(value => { report.metrics.stopAcknowledgedMs = since(); report.stop.stoppedTurns = Number.isSafeInteger(value?.stopped) && value.stopped >= 0 ? value.stopped : null
            report.stop.acknowledged = report.stop.stoppedTurns !== null; return report.stop.acknowledged })
          .catch(error => { report.stop.error = safeError(error); return false })
        return stopPromise
      }
      try {
        if (mode !== 'cleanup') {
          live = await openLive(session, fixtures.workspace.id, group.id, initial.revision)
          if ((await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
          clock = performance.now(); report.sentAt = new Date().toISOString(); sent = true; report.messageSendAttempts++; save()
          let message
          try { message = await api(session, `/api/conversations/${group.id}/messages`, { body: { body: prompt,
            mentions: [{ memberType: 'bot', memberId: lead.botId }] } }) }
          catch { fail('group_send_unknown') }
          report.metrics.sendAcknowledgedMs = since()
          if (!UUID.test(message?.id ?? '') || message.conversationId !== group.id || message.authorType !== 'user' || message.authorId !== ALEX_OWNER_ID ||
            scenario === 'private' && !/^[1-9]\d*$/.test(String(message.position ?? ''))) fail('group_message_invalid')
          report.messageId = message.id; save()
          if (boundary !== 'after_send') {
            const deadline = performance.now() + boundaryTimeoutMs
            let observedRevision = initial.revision
            for (let reads = 0; reads < maxLiveReads; reads++) {
              const remaining = deadline - performance.now()
              if (remaining <= 0) fail('group_boundary_timeout')
              const pushedRevision = await live.next(observedRevision, Math.min(60_000, remaining))
              live.summary.readsTriggered++
              const raw = await api(session, `/api/conversations/${group.id}/messages?limit=20`, { timeoutMs: Math.max(1, Math.min(20_000, deadline - performance.now())) })
              lastState = stateMetadata(raw, botIds)
              observedRevision = Math.max(pushedRevision, lastState.revision)
              report.liveReads.push({ ...lastState, observedMs: since(), triggerRevision: pushedRevision }); save()
              if (lastState.status === 'running' && lastState.respondingBotId === selected.botId) {
                if (scenario === 'private') {
                  const exchange = privateExchange(raw, message, botIds)
                  if (exchange) {
                    // One decision read at a real exchange+responder boundary.
                    // A receipt still requires provider start/end correlation;
                    // no polling or public-state inference can replace it.
                    const trace = await api(session, `/api/conversations/${group.id}/decisions?limit=1`)
                    report.privateBoundary = { ...exchange, ...privateGenerationReceipt(trace, message.id, lead.botId, selected.botId), observedMs: since() }
                    break
                  }
                } else break
              }
              if (!lastState.active && lastState.messageCount > 0) fail('group_boundary_missed')
              if (reads === maxLiveReads - 1) fail('group_read_limit')
            }
          }
          report.beforeStop = lastState
          await stop(boundary === 'after_send' ? 'send_acknowledged' : scenario === 'private' ? 'private_generate_receipt' : 'public_responding_bot')
        } else await stop('independent_cleanup')
      } catch (error) { failure = error }
      finally {
        report.cleanup.status = 'running'
        if (sent && !stopPromise) await stop('error_cleanup')
        if (stopPromise) await stopPromise
        if (sent) {
          report.postStopReads++
          try {
            const afterRaw = await api(session, `/api/conversations/${group.id}/messages?limit=20`)
            report.afterStop = stateMetadata(afterRaw, botIds); report.metrics.postStopObservedMs = since()
            if (!report.messageId) {
              const recovered = afterRaw.messages.filter(message => message.authorType === 'user' && message.authorId === ALEX_OWNER_ID && message.body === prompt && UUID.test(message.id ?? ''))
              if (recovered.length === 1) { report.messageId = recovered[0].id; report.sendOutcome = 'read_after_unknown_no_retry' }
            }
            if (report.afterStop.active) fail('group_cleanup_pending')
            if (mode !== 'cleanup' && (!report.afterStop.stopped || !report.stop.acknowledged || !(report.stop.stoppedTurns > 0))) fail('group_stop_not_observed')
            if (report.messageId) {
              const trace = await api(session, `/api/conversations/${group.id}/decisions?limit=1`)
              const turn = Array.isArray(trace?.turns) ? trace.turns.find(turn => turn.messageId === report.messageId) : null
              if (!turn) fail('group_trace_mismatch')
              const events = Array.isArray(turn.trace?.events) ? turn.trace.events : []
              report.turn = { messageId: report.messageId, status: fixed(turn.status, ['queued', 'running', 'complete', 'failed']),
                stoppedError: turn.error === 'stopped', traceStatus: fixed(turn.trace?.status, ['pending', 'complete', 'blocked', 'failed', 'stopped']),
                generateEntries: events.filter(event => event.type === 'generate').length,
                publicPublishes: events.filter(event => event.type === 'publish').length,
                privatePublishes: events.filter(event => event.type === 'private_publish').length,
                delegates: events.filter(event => event.type === 'delegate').length,
                humanCancellationRecorded: Array.isArray(turn.feedback) && turn.feedback.some(item => item.source === 'human_cancellation' && item.kind === 'cancelled_turn') }
              if (report.turn.delegates) fail('group_unexpected_delegation')
              if (mode !== 'cleanup' && (!report.turn.stoppedError || report.turn.traceStatus !== 'stopped' || !report.turn.humanCancellationRecorded)) fail('group_trace_mismatch')
            }
          } catch (error) { failure ??= error; report.cleanup.stateError = safeError(error); report.cleanup.status = 'needs_followup' }
        }
        const observedIdle = report.afterStop ? report.afterStop.active === false : !sent && initial.active === false
        if (sent && mode !== 'cleanup') {
          // Leave membership unchanged until the provider has actually ended
          // and the independent final audit has ruled out late side effects.
          // Removing a responder now could mask a broken cancellation fence.
          report.cleanup.retainedForProviderAudit = true
          report.cleanup.retainedBotIds = [...presentBotIds]
          if (report.cleanup.status === 'running') report.cleanup.status = 'retained_for_provider_audit'
        } else if (observedIdle && (mode === 'cleanup' || !sent)) {
          for (const botId of presentBotIds) {
            try {
              const removed = await api(session, `/api/conversations/${group.id}/members`, { method: 'DELETE', body: { memberType: 'bot', memberId: botId } })
              if (removed?.ok !== true) fail('group_cleanup_pending')
              report.cleanup.removedBotIds.push(botId)
            } catch (error) { failure ??= error; report.cleanup.status = 'needs_followup' }
          }
          try {
            const hidden = await api(session, `/api/mobile/groups/${group.id}`, { method: 'PATCH', body: { hidden: true } })
            if (hidden?.ok !== true) fail('group_cleanup_pending')
            report.cleanup.hidden = true
          } catch (error) { failure ??= error; report.cleanup.status = 'needs_followup' }
        }
        if (live) {
          report.live = live.summary
          if (!await live.close()) { failure ??= new Error('live_close_failed'); report.cleanup.status = 'needs_followup' }
        }
        if (report.cleanup.status === 'running') report.cleanup.status = 'complete'
        save()
      }
      if (failure) throw failure
      if (expectedSha && (await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
      report.status = mode === 'cleanup' ? 'cleanup_complete' : 'stop_evidence_captured'
    }, { expectedSha, deadlineAt: began + 210_000,
      onSession: value => { sessionDiagnostics = value; requests = value.requests } })
    if (sessionDiagnostics ? !sessionDiagnostics.signOut.succeeded : !requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; report.error = safeError(error) }
  if (sessionDiagnostics) report.sessionSignOut = { ...sessionDiagnostics.signOut }
  report.signedOut = sessionDiagnostics ? sessionDiagnostics.signOut.succeeded : requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  report.finishedAt = new Date().toISOString(); save(); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2] ?? 'observe'
    const groupReceipt = mode === 'cleanup' && process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : null
    const report = await runGroupStop({ mode, groupReceipt })
    console.log(JSON.stringify(report))
    if (!['stop_evidence_captured', 'cleanup_complete'].includes(report.status)) process.exitCode = 1
  } catch (error) { console.log(JSON.stringify({ issue: 1506, phase: 'alex-group-stop', status: 'failed', error: safeError(error) })); process.exitCode = 1 }
}
