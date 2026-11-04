import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const TOKEN = /^[A-Za-z0-9_.:-]{1,180}$/
const HASH = /^[a-f0-9]{64}$/
const FLASH = new Set(['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek/deepseek-flash', 'deepseek/deepseek-v4.1-flash'])
const ROLES = ['UI', 'Coding', 'Testing']
const PUBLIC_ROLES = { UI: '负责界面设计、用户交互与可用性。', Coding: '负责代码实现与修复软件缺陷。', Testing: '负责测试设计、回归测试与质量验证。' }
const NEW_ROLE = '负责基础代数辅导，解释一元一次方程的解法；当前不负责代码实现、界面设计或测试。'
const hash = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
class RoutingError extends Error { constructor(code, fatal = true) { super('group_routing_' + code); this.fatal = fatal } }
const check = (ok, code, fatal = true) => { if (!ok) throw new RoutingError(code, fatal) }
const safeError = error => error instanceof RoutingError ? error.message : 'group_routing_unconfirmed'
const memberKeys = members => members.map(m => m.memberType + ':' + m.id).sort()

/**
 * Prepared standalone addon. The caller owns normal session login/logout,
 * canonical-origin transport, an exclusive fixture run, and a fixed deployment.
 * Bot/group receipts must be the actual 201 responses from that same run.
 * No credential creation, new fixture creation or Factory dispatch. An explicit
 * option can reselect the same Flash model only for these proven fixture Bots.
 */
export async function runGroupRoutingBoundaries({ owner, verifyTarget, assertFlashTestModel,
  decisionModelId, fixture, allowFixtureFlashSelection = false, now = Date.now, wait = delay, budgetMs = 600_000 }) {
  check(typeof owner?.request === 'function' && typeof verifyTarget === 'function'
    && typeof assertFlashTestModel === 'function', 'normal_transport_required')
  check(Number.isSafeInteger(budgetMs) && budgetMs >= 1000 && budgetMs <= 600_000, 'budget_invalid')
  check(typeof decisionModelId === 'string' && /^[a-z0-9_.:/-]{1,100}$/i.test(decisionModelId), 'decision_model_required')
  const started = now(), hardDeadline = started + budgetMs
  const workDeadline = hardDeadline - Math.min(60_000, Math.floor(budgetMs / 10))
  const report = { schemaVersion: 1, status: 'failed', scope: 'single-run-group-routing', conversationId: null,
    messageAttempts: 0, acceptedMessages: 0, maxMessages: 8, budgetMs, cases: [], errors: [], fixtureModelSelections: [],
    cleanup: { role: { attempted: false, restored: false }, membership: { attempted: false, restored: false }, delegations: [] },
    coverage: { naturalSilence: false, answeredClosure: false, unrelatedSilence: false, coding: false,
      testing: false, sequentialIncremental: false, immediateRoleRouting: false, nonmemberMention: false,
      factoryDispatchedByDriver: false, modelSelectionChanged: false, replayIncluded: false } }
  let f, bots, groupId, groupTitle, workspaceId, ownerId, initialKeys, basePosition = 0n, initialTurns = new Set()
  let roleAttempted = false, roleRestoreTried = false, previousRole, removedId = null, memberAttempted = false, memberRestoreTried = false
  const roots = new Set(), observedRoots = new Set(), executionIds = new Set(), generationIds = new Set()
  let lastTrace
  function remaining(cleanup = false) {
    const ms = (cleanup ? hardDeadline : workDeadline) - now()
    check(ms > 0, 'budget_exhausted')
    return Math.max(1, Math.min(15_000, Math.floor(ms)))
  }
  async function request(path, method = 'GET', body, cleanup = false) {
    const response = await owner.request(path, { method, redirect: 'error', signal: AbortSignal.timeout(remaining(cleanup)),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const text = await response.text()
    check(Buffer.byteLength(text) <= 1024 * 1024, 'body_limit')
    let data
    try { data = JSON.parse(text) } catch { throw new RoutingError('response_shape') }
    return { status: response.status, data }
  }
  async function get(path, cleanup = false) {
    const result = await request(path, 'GET', undefined, cleanup)
    check(result.status === 200, 'read_failed')
    return result.data
  }
  async function target(cleanup = false) {
    const signal = AbortSignal.timeout(remaining(cleanup))
    let abort
    const expired = new Promise((_, reject) => {
      abort = () => reject(new RoutingError('target_timeout'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try { await Promise.race([Promise.resolve().then(() => verifyTarget({ signal })), expired]) }
    finally { signal.removeEventListener('abort', abort) }
    remaining(cleanup)
  }
  function validateReceipts() {
    f = fixture
    const projected = fixture?.creationReport
    if (projected) {
      check(fixture.coreBundleStatus === 'pass' && projected.status === 'pass'
        && HASH.test(fixture.reportSha256 ?? '') && hash(JSON.stringify(projected)) === fixture.reportSha256
        && /^[a-f0-9]{40}$/.test(fixture.sourcePin?.revision ?? '') && /^dpl_[A-Za-z0-9]+$/.test(fixture.sourcePin?.deploymentId ?? '')
        && projected.revision === fixture.sourcePin.revision && projected.deploymentId === fixture.sourcePin.deploymentId,
      'report_source_binding')
      f = { exclusive: fixture.exclusive, fixtureId: projected.fixtureId, ownerId: projected.requesterId,
        workspaceId: projected.workspaceId, startedAt: projected.startedAt, bots: projected.bots }
      report.creationEvidence = { kind: 'fixed-core-group-report-projection', sha256: fixture.reportSha256,
        revision: projected.revision, deploymentId: projected.deploymentId }
    } else report.creationEvidence = { kind: 'normal-http-201-receipts' }
    check(f?.exclusive === true && UUID.test(f.fixtureId ?? '') && TOKEN.test(f.ownerId ?? '')
      && UUID.test(f.workspaceId ?? '') && Array.isArray(f.bots) && f.bots.length === 3, 'fixture_receipt_required')
    check(Number.isFinite(Date.parse(f.startedAt)), 'fixture_time_required')
    const prefix = f.fixtureId.slice(0, 8)
    bots = new Map()
    for (const role of ROLES) {
      const item = f.bots.find(b => b.role === role), r = item?.creationReceipt
      const body = projected ? { id: item?.id, name: 'Acceptance ' + role + ' ' + prefix, ownerId: f.ownerId, workspaceId: f.workspaceId } : r?.body
      check((projected || r?.status === 201) && UUID.test(body?.id ?? '') && body.ownerId === f.ownerId
        && body.workspaceId === f.workspaceId && body.name === 'Acceptance ' + role + ' ' + prefix
        && FLASH.has(item.modelId), 'bot_receipt_scope')
      assertFlashTestModel(item.modelId)
      bots.set(role, { ...body, role, modelId: item.modelId })
    }
    check(new Set([...bots.values()].map(b => b.id)).size === 3, 'duplicate_bot_receipt')
    const r = f.conversationReceipt
    groupTitle = 'Proactive acceptance ' + prefix
    if (projected) check(UUID.test(projected.conversationId ?? ''), 'conversation_receipt_scope')
    else check(r?.status === 201 && UUID.test(r.body?.id ?? '') && r.body.title === groupTitle
        && r.request?.workspaceId === f.workspaceId && r.request.title === r.body.title
        && Array.isArray(r.request.members)
        && same(r.request.members.map(m => m.memberType + ':' + m.memberId).sort(), [...bots.values()].map(b => 'bot:' + b.id).sort()), 'conversation_receipt_scope')
    groupId = projected ? projected.conversationId : r.body.id
    workspaceId = f.workspaceId; ownerId = f.ownerId; report.conversationId = groupId
  }
  async function owned(cleanup = false) {
    const session = await get('/api/auth/get-session', cleanup)
    check(session?.user?.id === ownerId, 'session_owner_changed')
    const visible = await get('/api/bots', cleanup)
    check(Array.isArray(visible), 'bots_shape')
    for (const bot of bots.values()) check(visible.some(b => b.id === bot.id && b.ownerId === ownerId
      && b.workspaceId === workspaceId && b.name === bot.name), 'fixture_owner_changed')
    const page = await get('/api/conversations?workspaceId=' + workspaceId, cleanup)
    const group = page?.conversations?.find(g => g.id === groupId)
    check(group?.createdBy === ownerId && group.workspaceId === workspaceId
      && group.title === groupTitle && group.kind === 'group'
      && Number.isFinite(Date.parse(group.createdAt)) && Date.parse(group.createdAt) >= Date.parse(f.startedAt) - 5000,
    'group_owner_changed')
    return group
  }
  async function members(cleanup = false) {
    const page = await get('/api/conversations/' + groupId + '/members', cleanup)
    check(Array.isArray(page?.members), 'members_shape')
    const ownerMember = page.members.find(m => m.memberType === 'user' && m.id === ownerId)
    check(ownerMember?.role === 'owner', 'group_owner_membership')
    return page.members
  }
  async function quality(cleanup = false) {
    const result = await get('/api/conversations/' + groupId + '/decisions?limit=100', cleanup)
    check(Array.isArray(result?.turns) && result.feedbackIsGroundTruth === false, 'trace_contract')
    for (const turn of result.turns) check(initialTurns.has(turn.messageId) || roots.has(turn.messageId), 'concurrent_group_turn')
    return result
  }
  async function history(cleanup = false) {
    const page = await get('/api/conversations/' + groupId + '/messages?limit=100', cleanup)
    check(Array.isArray(page?.messages), 'messages_shape')
    for (const m of page.messages) {
      check(/^[0-9]+$/.test(String(m.position)), 'position_shape')
      if (BigInt(m.position) <= basePosition) continue
      const ownRoot = roots.has(m.id) && m.authorType === 'user' && m.authorId === ownerId
      const ownReply = roots.has(m.replyToId) && m.authorType === 'bot' && [...bots.values()].some(b => b.id === m.authorId)
      check(ownRoot || ownReply, 'concurrent_group_message')
    }
    return page
  }
  async function guard() {
    await target()
    await owned()
    check(same(memberKeys(await members()), initialKeys), 'member_set_changed')
    await history()
    const q = await quality()
    check(q.turns.every(t => !['queued', 'running'].includes(t.status)), 'group_not_idle')
    for (const bot of bots.values()) {
      const menu = await get('/api/mobile/model?bot=' + bot.id)
      check(menu?.current?.available === true && menu.current.kind === 'apiKey' && menu.current.provider === 'deepseek'
        && menu.current.modelId === bot.modelId && FLASH.has(menu.current.modelId), 'flash_selection_changed')
      assertFlashTestModel(menu.current.modelId)
    }
  }
  function receipt(execution) {
    check(execution?.modelId === decisionModelId && TOKEN.test(execution.executionId ?? '')
      && TOKEN.test(execution.providerGenerationId ?? '') && HASH.test(execution.requestDigest ?? '')
      && Number.isFinite(Date.parse(execution.startedAt)) && Number.isFinite(Date.parse(execution.completedAt))
      && Date.parse(execution.completedAt) >= Date.parse(execution.startedAt)
      && Array.isArray(execution.imageDigests) && execution.imageDigests.length === 0, 'decision_receipt_missing')
    return { executionId: execution.executionId, modelId: execution.modelId, providerGenerationId: execution.providerGenerationId,
      requestDigest: execution.requestDigest, startedAt: new Date(execution.startedAt).toISOString(), completedAt: new Date(execution.completedAt).toISOString() }
  }
  async function prepareFixtureModels() {
    if (!allowFixtureFlashSelection) return
    check(report.creationEvidence.kind === 'fixed-core-group-report-projection' && fixture.coreBundleStatus === 'pass', 'model_selection_provenance')
    for (const bot of bots.values()) {
      const menu = await get('/api/mobile/model?bot=' + bot.id)
      if (menu?.current?.available === true && menu.current.kind === 'apiKey'
        && menu.current.provider === 'deepseek' && menu.current.modelId === bot.modelId) continue
      const option = (menu?.groups ?? []).filter(g => g.kind === 'apiKey').flatMap(g => g.options ?? [])
        .find(o => o.provider === 'deepseek' && o.modelId === bot.modelId && typeof o.id === 'string'
          && o.id.startsWith('apikey:') && UUID.test(o.id.slice(7, 43)) && o.id.slice(43) === ':' + bot.modelId)
      check(option && FLASH.has(option.modelId), 'fixture_flash_option_unavailable')
      assertFlashTestModel(option.modelId)
      await target(); await owned()
      check(same(memberKeys(await members()), initialKeys)
        && (await quality()).turns.every(t => !['queued', 'running'].includes(t.status)), 'model_selection_group_changed')
      const row = { botId: bot.id, modelId: bot.modelId, attempted: true, httpStatus: null, availableReadback: false }
      report.fixtureModelSelections.push(row)
      let write
      try { write = await request('/api/mobile/model', 'PUT', { bot: bot.id, id: option.id }); row.httpStatus = write.status }
      catch { /* Observe once; never retry an unknown preference write. */ }
      const after = (await get('/api/mobile/model?bot=' + bot.id))?.current
      row.availableReadback = after?.id === option.id && after.kind === 'apiKey' && after.provider === 'deepseek'
        && after.available === true && after.modelId === bot.modelId
      if (row.availableReadback) report.coverage.modelSelectionChanged = true
      check(write?.status === 200 && row.availableReadback, 'fixture_flash_selection_unconfirmed')
    }
  }
  async function terminal(messageId) {
    const end = Math.min(workDeadline, now() + 75_000)
    while (now() < end) {
      const q = await quality(), turn = q.turns.find(t => t.messageId === messageId)
      const page = await history()
      if (turn && ['complete', 'failed', 'stopped'].includes(turn.status)) return { turn, page }
      await wait(Math.min(1000, Math.max(1, end - now())))
    }
    throw new RoutingError('turn_timeout')
  }
  async function cancelUnexpected(messageId, trace) {
    const evidence = { messageId, taskId: null, runId: null, issueId: null, reporterId: null,
      status: 'needs-scope-cleanup', cancelAttempted: false, cancellationRecorded: false, executionStopConfirmed: false }
    report.cleanup.delegations.push(evidence)
    try {
      check(roots.has(messageId), 'cancel_message_scope')
      const events = trace.events?.filter(e => e.type === 'delegate' && e.outcome === 'succeeded') ?? []
      check(events.length === 1, 'cancel_receipt_missing')
      const event = events[0]
      check(UUID.test(event.taskId ?? '') && UUID.test(event.runId ?? '') && [...bots.values()].some(b => b.id === event.memberId)
        && same(trace.responders, [event.memberId]), 'cancel_receipt_scope')
      Object.assign(evidence, { taskId: event.taskId, runId: event.runId, reporterId: event.memberId })
      await target(true); await owned(true)
      const fresh = await quality(true), source = fresh.turns.find(t => t.messageId === messageId)
      check(source?.trace?.events?.some(e => e.type === 'delegate' && e.outcome === 'succeeded'
        && e.taskId === event.taskId && e.runId === event.runId && e.memberId === event.memberId), 'cancel_trace_changed')
      const state = await get('/api/factory/tasks/' + event.taskId, true)
      const task = state?.task, run = (await get('/api/runs/' + event.runId + '/evidence', true))?.run
      check(task?.id === event.taskId && task.userId === ownerId && task.botId === event.memberId && UUID.test(task.issueId ?? '')
        && UUID.test(task.sourceEventId ?? '') && Number.isSafeInteger(task.revision) && task.revision >= 1
        && UUID.test(task.attemptId ?? '') && (task.candidateId === null || UUID.test(task.candidateId ?? ''))
        && state.attempts?.some(a => a.id === task.attemptId && a.runId === event.runId && a.output?.requestEpoch === task.sourceEventId),
      'cancel_task_scope')
      const identity = run?.executionIdentity
      check(run?.id === event.runId && run.issueId === task.issueId && run.botId === event.memberId
        && identity?.requester === ownerId && identity.executionPrincipal === ownerId && identity.outputOwner === ownerId
        && identity.botOwner === ownerId && identity.botId === event.memberId && identity.workspaceId === workspaceId, 'cancel_run_scope')
      evidence.issueId = task.issueId
      if (['cancelled', 'revoked'].includes(task.status)) { evidence.status = 'cancellation-recorded'; evidence.cancellationRecorded = true; return }
      if (task.status === 'passed' && ['approval', 'publish', 'monitor'].includes(task.stage)) { evidence.status = 'already-complete'; return }
      const binding = { taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, candidateId: task.candidateId, revision: task.revision }
      evidence.cancelAttempted = true
      let acknowledged = false
      try { const r = await request('/api/factory/tasks/' + task.id, 'POST', { binding, eventId: randomUUID(), action: 'cancel',
        reason: 'Stop the unexpected task produced by this synthetic routing-only acceptance message; retain its evidence.' }, true)
        acknowledged = r.status === 200
      } catch { /* Unknown write is observed once, never replayed. */ }
      const after = (await get('/api/factory/tasks/' + task.id, true))?.task
      check(after?.id === task.id && after.userId === ownerId && after.sourceEventId === task.sourceEventId
        && ['cancelled', 'revoked'].includes(after.status), 'cancel_not_recorded')
      evidence.cancellationRecorded = true
      evidence.status = acknowledged ? 'cancellation-recorded' : 'cancellation-observed-write-unconfirmed'
    } catch (error) { evidence.error = safeError(error) }
  }
  async function scenario(name, body, expected, replyToId) {
    const row = { name, status: 'failed', promptDigest: hash(body), messageId: null, action: null,
      responders: [], wakes: null, generations: null, publications: null, replies: null, decision: null, responseDigests: [] }
    report.cases.push(row)
    try {
      await guard(); check(report.messageAttempts < 8, 'message_limit')
      report.messageAttempts++
      let sent
      try { sent = await request('/api/conversations/' + groupId + '/messages', 'POST', { body, mentions: [], ...(replyToId ? { replyToId } : {}) }) }
      catch { throw new RoutingError('message_submission_unconfirmed') }
      check(sent.status === 201 && UUID.test(sent.data?.id ?? ''), 'message_submission_rejected')
      row.messageId = sent.data.id; roots.add(sent.data.id); report.acceptedMessages++
      const { turn, page } = await terminal(sent.data.id), trace = turn.trace
      check(trace && Array.isArray(trace.events) && Array.isArray(trace.responders), 'trace_shape')
      const replies = page.messages.filter(m => m.replyToId === sent.data.id && m.authorType !== 'user')
        .sort((a, b) => BigInt(a.position) < BigInt(b.position) ? -1 : 1)
      row.action = ['ignore', 'observe', 'reply', 'clarify', 'delegate'].includes(trace.action) ? trace.action : 'invalid'
      row.responders = trace.responders.filter(id => [...bots.values()].some(b => b.id === id))
      row.responderCount = trace.responders.length
      row.unknownResponderCount = trace.responders.length - row.responders.length
      const wakeEvents = trace.events.filter(e => e.type === 'wake')
      row.wakes = wakeEvents.length
      row.generations = trace.events.filter(e => e.type === 'generate').length
      row.publications = trace.events.filter(e => e.type === 'publish').length
      row.replies = replies.length
      row.responseDigests = replies.map(m => ({ messageId: UUID.test(m.id ?? '') ? m.id : null,
        responderId: [...bots.values()].some(b => b.id === m.authorId) ? m.authorId : null, digest: hash(String(m.body).trim()) }))
      if (trace.action === 'delegate' || trace.events.some(e => e.type === 'delegate')) {
        await cancelUnexpected(sent.data.id, trace)
        throw new RoutingError('unexpected_delegation')
      }
      check(turn.status === 'complete' && trace.status === 'complete' && trace.policyVersion === 'group-contribution-v1', 'turn_not_complete')
      row.decision = receipt(trace.execution)
      check(!executionIds.has(row.decision.executionId) && !generationIds.has(row.decision.providerGenerationId), 'decision_receipt_reused')
      executionIds.add(row.decision.executionId); generationIds.add(row.decision.providerGenerationId)
      observedRoots.add(sent.data.id)
      lastTrace = trace
      check(expected.actions.includes(trace.action) && same(trace.responders, expected.ids), 'route_mismatch', false)
      check(row.wakes <= expected.ids.length && new Set(wakeEvents.map(e => e.memberId)).size === row.wakes
        && wakeEvents.every(e => expected.ids.includes(e.memberId)), 'wake_scope_mismatch', false)
      check(row.generations === expected.ids.length && row.publications === expected.ids.length && replies.length === expected.ids.length
        && !trace.events.some(e => ['private_publish', 'task_result'].includes(e.type)), 'effect_count_mismatch', false)
      check(same(replies.map(m => m.authorId), expected.ids) && replies.every(m => m.authorType === 'bot'), 'reply_scope_mismatch', false)
      const published = trace.events.filter(e => e.type === 'publish')
      check(published.every((e, i) => e.memberId === expected.ids[i] && e.contentDigest === hash(String(replies[i]?.body).trim())), 'publication_digest_mismatch', false)
      if (expected.incremental) {
        const steps = trace.events.filter(e => ['generate', 'publish'].includes(e.type)).map(e => e.type + ':' + e.memberId)
        row.incremental = { sequential: same(steps, ['generate:' + expected.ids[0], 'publish:' + expected.ids[0], 'generate:' + expected.ids[1], 'publish:' + expected.ids[1]]),
          distinct: row.responseDigests[0]?.digest !== row.responseDigests[1]?.digest,
          interfaceContent: /按钮|交互|点击|加载|禁用|button|loading|disabled/i.test(replies[0]?.body ?? ''),
          verificationContent: /断言|预期|期望|验证|assert|expect|verify/i.test(replies[1]?.body ?? ''),
          concreteRepeatedClickCheck: /双击|连击|连续|重复|double.?click|rapid|repeated/i.test(replies[1]?.body ?? '') }
        check(Object.values(row.incremental).every(Boolean), 'incremental_content_mismatch', false)
      }
      if (expected.changedRoleDigest) {
        const current = trace.members?.find(m => m.id === bots.get('Coding').id)?.roleDigest
        row.roleDigestChanged = HASH.test(current ?? '') && current !== expected.changedRoleDigest
        check(row.roleDigestChanged, 'role_snapshot_not_refreshed', false)
      }
      const again = (await quality()).turns.find(t => t.messageId === sent.data.id)
      check(again?.status === 'complete' && same(again.trace?.events, trace.events), 'duplicate_or_changed_effects', false)
      row.status = 'passed'
      return { messageId: sent.data.id, replies, trace }
    } catch (error) {
      row.error = safeError(error)
      if (!(error instanceof RoutingError) || error.fatal) throw error
      return null
    }
  }
  async function restoreRole() {
    if (!roleAttempted || roleRestoreTried) return
    roleRestoreTried = true; report.cleanup.role.attempted = true
    try {
      await target(true); await owned(true)
      const path = '/api/bots/' + bots.get('Coding').id, current = await get(path, true)
      check(current?.id === bots.get('Coding').id && [previousRole, NEW_ROLE].includes(current.publicRole), 'role_external_change')
      if (current.publicRole === NEW_ROLE) {
        report.cleanup.role.writeOutcome = 'unconfirmed'
        try { const result = await request(path, 'PATCH', { publicRole: previousRole }, true)
          if (result.status === 200) report.cleanup.role.writeOutcome = 'acknowledged'
        } catch { /* Read back; no second PATCH. */ }
      }
      check((await get(path, true)).publicRole === previousRole, 'role_restore_unconfirmed')
      report.cleanup.role.restored = true
    } catch (error) { report.cleanup.role.error = safeError(error) }
  }
  async function restoreMember() {
    if (!memberAttempted || memberRestoreTried) return
    memberRestoreTried = true; report.cleanup.membership.attempted = true
    try {
      await target(true); await owned(true)
      const current = memberKeys(await members(true)), without = initialKeys.filter(k => k !== 'bot:' + removedId)
      check(same(current, initialKeys) || same(current, without), 'membership_external_change')
      if (same(current, without)) {
        report.cleanup.membership.writeOutcome = 'unconfirmed'
        try { const result = await request('/api/conversations/' + groupId + '/members', 'POST', { memberType: 'bot', memberId: removedId }, true)
          if (result.status === 200) report.cleanup.membership.writeOutcome = 'acknowledged'
        }
        catch { /* Read back; no duplicate add. */ }
      }
      check(same(memberKeys(await members(true)), initialKeys), 'membership_restore_unconfirmed')
      report.cleanup.membership.restored = true
    } catch (error) { report.cleanup.membership.error = safeError(error) }
  }
  try {
    validateReceipts(); await target()
    const group = await owned(), initial = await members()
    initialKeys = ['user:' + ownerId, ...[...bots.values()].map(b => 'bot:' + b.id)].sort()
    check(same(memberKeys(initial), initialKeys) && group.leadAgentId == null, 'fixture_member_scope')
    check(/^[0-9]+$/.test(String(group.lastPosition)), 'position_shape'); basePosition = BigInt(group.lastPosition)
    const q = await get('/api/conversations/' + groupId + '/decisions?limit=100')
    check(Array.isArray(q?.turns) && q.feedbackIsGroundTruth === false && q.turns.every(t => !['queued', 'running'].includes(t.status)), 'group_not_idle')
    initialTurns = new Set(q.turns.map(t => t.messageId))
    for (const bot of bots.values()) {
      const profile = await get('/api/bots/' + bot.id)
      check(profile?.id === bot.id && profile.publicRole === PUBLIC_ROLES[bot.role], 'initial_role_changed')
      if (bot.role === 'Coding') previousRole = profile.publicRole
    }
    await prepareFixtureModels()
    const quiet = { actions: ['ignore', 'observe'], ids: [] }
    report.coverage.naturalSilence = Boolean(await scenario('natural-casual-chat', '今天午饭吃了面，回家路上还看到一只猫。', quiet))
    report.coverage.unrelatedSilence = Boolean(await scenario('unrelated-content', '下周表哥的婚礼安排在周六上午，家里刚确认了这件事。', quiet))
    const coding = await scenario('coding-without-mention', '这是一个代码理解问题，不改项目也不执行命令：JavaScript 的 [0, 1, 2].filter(Boolean) 为什么会丢掉 0？只过滤 null 和 undefined 时，判断条件应该怎么写？请给简短代码说明。',
      { actions: ['reply'], ids: [bots.get('Coding').id] })
    report.coverage.coding = Boolean(coding)
    if (coding?.replies[0]?.id) report.coverage.answeredClosure = Boolean(await scenario('answered-question-closure', '谢谢，刚才的说明已经解决了我的疑问，这个问题到这里结束了。', quiet, coding.replies[0].id))
    else report.cases.push({ name: 'answered-question-closure', status: 'failed', error: 'group_routing_answered_prerequisite_missing' })
    report.coverage.testing = Boolean(await scenario('testing-without-mention', '这是测试设计讨论，不运行测试：登录表单需要覆盖空密码、错误密码和重复点击提交。请给出这三个回归用例各自的预期结果。',
      { actions: ['reply'], ids: [bots.get('Testing').id] }))
    report.coverage.sequentialIncremental = Boolean(await scenario('ui-testing-incremental', '这是方案讨论，不执行任务：移动端提交按钮被连续点击可能生成重复订单。请先从界面交互角度给一个防止误触的设计建议，再从测试角度在前一个建议上补充一个可复现的回归检查与断言，只补充新信息。',
      { actions: ['reply'], ids: [bots.get('UI').id, bots.get('Testing').id], incremental: true }))
    await guard()
    const beforeDigest = lastTrace?.members?.find(m => m.id === bots.get('Coding').id)?.roleDigest
    check(HASH.test(beforeDigest ?? ''), 'prior_role_snapshot_missing')
    const codingPath = '/api/bots/' + bots.get('Coding').id
    check((await get(codingPath)).publicRole === previousRole, 'role_external_change')
    roleAttempted = true
    const patched = await request(codingPath, 'PATCH', { publicRole: NEW_ROLE })
    check(patched.status === 200 && (await get(codingPath)).publicRole === NEW_ROLE, 'role_change_unconfirmed')
    report.coverage.immediateRoleRouting = Boolean(await scenario('changed-public-role-next-message', '我需要理解这道代数题：3x + 5 = 20。先移项、再相除分别得到什么？请负责代数辅导的成员用两步解释。',
      { actions: ['reply'], ids: [bots.get('Coding').id], changedRoleDigest: beforeDigest }))
    await restoreRole()
    check(report.cleanup.role.restored, 'role_restore_failed')
    await guard()
    const currentGroup = await owned()
    removedId = [...bots.values()].find(b => b.role !== 'UI' && b.id !== currentGroup.leadBotId)?.id
    check(removedId, 'nonlead_fixture_required')
    memberAttempted = true
    const removed = await request('/api/conversations/' + groupId + '/members', 'DELETE', { memberType: 'bot', memberId: removedId })
    check(removed.status === 200 && removed.data?.ok === true
      && same(memberKeys(await members()), initialKeys.filter(k => k !== 'bot:' + removedId)), 'member_removal_unconfirmed')
    const before = await history(), beforeTurns = (await quality()).turns.map(t => t.messageId).sort()
    await target(); await owned()
    const body = '请解释 JavaScript 的空值判断。', mentions = [{ memberType: 'bot', memberId: removedId }]
    check(body.length > 0 && body.length <= 32000 && UUID.test(removedId), 'mention_shape_invalid')
    const row = { name: 'owned-nonmember-mention', status: 'failed', promptDigest: hash(body), responderId: removedId,
      validShape: true, removedMembershipReadback: true, httpStatus: null, noMessageOrTurnCreated: false }
    report.cases.push(row); check(report.messageAttempts < 8, 'message_limit'); report.messageAttempts++
    const rejected = await request('/api/conversations/' + groupId + '/messages', 'POST', { body, mentions })
    row.httpStatus = rejected.status
    if (rejected.status === 201 && UUID.test(rejected.data?.id ?? '')) {
      roots.add(rejected.data.id); report.acceptedMessages++; row.messageId = rejected.data.id
      const result = await terminal(rejected.data.id)
      if (result.turn.trace?.action === 'delegate' || result.turn.trace?.events?.some(e => e.type === 'delegate')) await cancelUnexpected(rejected.data.id, result.turn.trace)
    }
    check(rejected.status === 422 && rejected.data?.error === 'invalid_input', 'nonmember_not_rejected')
    const after = await history(), afterTurns = (await quality()).turns.map(t => t.messageId).sort()
    row.noMessageOrTurnCreated = same(before.messages.map(m => m.id).sort(), after.messages.map(m => m.id).sort()) && same(beforeTurns, afterTurns)
    check(row.noMessageOrTurnCreated, 'rejected_mention_side_effect')
    await restoreMember()
    check(report.cleanup.membership.restored, 'membership_restore_failed')
    row.restoredMembershipReadback = true; row.status = 'passed'; report.coverage.nonmemberMention = true
  } catch (error) { report.errors.push(safeError(error)) }
  finally { await restoreRole(); await restoreMember() }
  const required = ['naturalSilence', 'answeredClosure', 'unrelatedSilence', 'coding', 'testing', 'sequentialIncremental', 'immediateRoleRouting', 'nonmemberMention']
  report.observedDecisionReceipts = observedRoots.size
  report.requiresScopeCleanup = report.errors.some(code => /submission_unconfirmed|turn_timeout|trace_shape/.test(code))
    || report.cleanup.delegations.some(d => d.status === 'needs-scope-cleanup')
    || (roleAttempted && !report.cleanup.role.restored) || (memberAttempted && !report.cleanup.membership.restored)
  report.elapsedMs = Math.max(0, now() - started)
  if (report.cleanup.role.writeOutcome === 'unconfirmed' || report.cleanup.membership.writeOutcome === 'unconfirmed')
    report.errors.push('group_routing_cleanup_write_unconfirmed')
  report.status = required.every(k => report.coverage[k]) && report.errors.length === 0
    && report.cases.length === 8 && report.cases.every(c => c.status === 'passed')
    && report.cleanup.role.restored && report.cleanup.membership.restored && report.elapsedMs <= budgetMs ? 'passed' : 'failed'
  return report
}
