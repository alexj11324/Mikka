import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const TOKEN = /^[A-Za-z0-9_.:-]{1,180}$/
const HASH = /^[a-f0-9]{64}$/
const POLICIES = ['group-route-v0', 'group-contribution-v1', 'group-contribution-v2', 'group-contribution-v3']
const ENDED = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled'])
const FAILURES = new Set(['unavailable', 'missing_or_refused', 'wrong_answer_type', 'uncertain', 'choice_outside_contract', 'receipt_missing', 'duplicate_receipt', 'mention_requires_intervention', 'reporter_unavailable', 'call_budget_exhausted', 'invalid_response', 'members_unavailable'])
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
const pending = turn => ['queued', 'running'].includes(turn.status) || turn.status === 'failed' && turn.error === 'group_judgment_pending'

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
  const workDeadline = hardDeadline - Math.min(180_000, Math.floor(budgetMs / 3))
  const report = { schemaVersion: 1, status: 'failed', scope: 'single-run-group-routing', conversationId: null,
    messageAttempts: 0, acceptedMessages: 0, maxMessages: 8, budgetMs, cases: [], failedTurns: [], errors: [], fixtureModelSelections: [],
    costScope: 'routing-decision-chain', callerSessionAndCredentialCleanupRequired: true,
    cleanup: { role: { attempted: false, restored: false }, membership: { attempted: false, restored: false }, delegations: [],
      group: { attempted: false, acknowledged: false, noPendingRetry: false }, knownDelegationsReviewed: false,
      unobservedSubmission: false, unboundDelegateObserved: false },
    coverage: { naturalSilence: false, answeredClosure: false, unrelatedSilence: false, coding: false,
      testing: false, sequentialIncremental: false, immediateRoleRouting: false, nonmemberMention: false,
      factoryDispatchedByDriver: false, modelSelectionChanged: false, replayIncluded: false } }
  let f, bots, groupId, groupTitle, workspaceId, ownerId, initialKeys, basePosition = 0n, initialTurns = new Set()
  let roleAttempted = false, roleRestoreTried = false, previousRole, removedId = null, memberAttempted = false, memberRestoreTried = false
  const roots = new Set(), observedRoots = new Set(), executionIds = new Set(), generationIds = new Set(), seenSteps = new Set(), cleanupAttempts = new Set()
  let scopeReady = false, stopTried = false
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
  async function quality(cleanup = false, allowUnbound = false) {
    const result = await get('/api/conversations/' + groupId + '/decisions?limit=100', cleanup)
    check(Array.isArray(result?.turns) && result.feedbackIsGroundTruth === false && result.costScope === 'routing-decision-chain', 'trace_contract')
    if (!allowUnbound) for (const turn of result.turns) check(initialTurns.has(turn.messageId) || roots.has(turn.messageId), 'concurrent_group_turn')
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
    check(q.turns.every(t => !pending(t)), 'group_not_idle')
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
        && (await quality()).turns.every(t => !pending(t)), 'model_selection_group_changed')
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
  function observation(turn) {
    const trace = turn.trace
    check(turn.status === 'complete' && trace?.status === 'complete' && POLICIES.includes(trace.policyVersion)
      && trace.decisionProtocol === 'group-sequential-v1' && Array.isArray(trace.decisions) && trace.decisions.length > 0
      && trace.decisions.length <= 64 && (trace.decisionsOmitted ?? 0) === 0, 'turn_not_complete')
    const primary = receipt(trace.execution)
    const start = trace.decisions.findIndex(step => step.receipt?.executionId === primary.executionId)
    check(start >= 0 && trace.decisions[start].index === 0, 'current_attempt_missing')
    const current = trace.decisions.slice(start)
    check(current.length <= 4 && current.every((step, index) => step.index === index && step.status === 'complete'
      && step.failure === null && step.policyVersion === trace.policyVersion)
      && current[0].phase === (trace.policyVersion === POLICIES[0] ? 'responder' : 'intent'), 'mixed_policy_chain')
    const steps = trace.decisions.map(step => {
      check(UUID.test(step.id ?? '') && !seenSteps.has(step.id) && POLICIES.includes(step.policyVersion)
        && ['intent', 'responder', 'delegation', 'report_timing'].includes(step.phase)
        && Number.isSafeInteger(step.index) && step.index >= 0 && step.index < 4, 'chain_unbound')
      seenSteps.add(step.id)
      const paid = step.receipt ? receipt(step.receipt) : null
      check(['complete', 'invalid_decision', 'unavailable'].includes(step.status)
        && (step.status === 'complete' ? paid && step.failure === null : FAILURES.has(step.failure))
        && (step.status === 'unavailable' ? !paid : paid), 'chain_status')
      if (paid) {
        check(!executionIds.has(paid.executionId) && !generationIds.has(paid.providerGenerationId), 'receipt_reused')
        executionIds.add(paid.executionId); generationIds.add(paid.providerGenerationId)
      }
      const amount = paid && typeof step.decisionCostUsd === 'number' && Number.isFinite(step.decisionCostUsd) && step.decisionCostUsd >= 0 ? step.decisionCostUsd : null
      return { id: step.id, phase: step.phase, index: step.index, policyVersion: step.policyVersion,
        status: step.status, failure: step.failure, receipt: paid, decisionCostUsd: amount }
    })
    return { messageId: turn.messageId, policyVersion: trace.policyVersion, primaryReceipt: primary, decisions: steps,
      providerCalls: { attempted: steps.length, receipted: steps.filter(step => step.receipt).length },
      knownCostUsd: steps.reduce((sum, step) => sum + (step.decisionCostUsd ?? 0), 0),
      unknownCostCalls: steps.filter(step => step.decisionCostUsd === null).length,
      completeCostUsd: steps.every(step => step.decisionCostUsd !== null) ? steps.reduce((sum, step) => sum + step.decisionCostUsd, 0) : null }
  }
  function retainFailedTurn(turn) {
    const trace = turn?.trace
    const safeReceipt = value => { try { return receipt(value) } catch { return null } }
    const steps = (Array.isArray(trace?.decisions) ? trace.decisions : []).slice(-64).map(step => {
      const paid = safeReceipt(step?.receipt)
      return { id: UUID.test(step?.id ?? '') ? step.id : null,
        phase: ['intent', 'responder', 'delegation', 'report_timing'].includes(step?.phase) ? step.phase : null,
        index: Number.isSafeInteger(step?.index) && step.index >= 0 && step.index < 4 ? step.index : null,
        policyVersion: POLICIES.includes(step?.policyVersion) ? step.policyVersion : null,
        status: ['complete', 'invalid_decision', 'unavailable'].includes(step?.status) ? step.status : null,
        failure: FAILURES.has(step?.failure) ? step.failure : null, receipt: paid,
        decisionCostUsd: paid && Number.isFinite(step?.decisionCostUsd) && step.decisionCostUsd >= 0 ? step.decisionCostUsd : null }
    })
    const uniquePaid = new Map(steps.filter(step => step.receipt).map(step => [step.receipt.providerGenerationId, step]))
    const observed = { messageId: UUID.test(turn?.messageId ?? '') ? turn.messageId : null,
      status: ['queued', 'running', 'failed', 'complete'].includes(turn?.status) ? turn.status : null,
      policyVersion: POLICIES.includes(trace?.policyVersion) ? trace.policyVersion : null,
      primaryReceipt: safeReceipt(trace?.execution), decisions: steps,
      costScope: 'routing-decision-chain', completeCostUsd: null,
      knownCostUsd: steps.length ? [...uniquePaid.values()].reduce((sum, step) => sum + (step.decisionCostUsd ?? 0), 0) : null,
      retainedSteps: steps.length, providerCallsComplete: false }
    const existing = report.failedTurns.findIndex(row => row.messageId === observed.messageId)
    if (existing < 0) report.failedTurns.push(observed)
    else report.failedTurns[existing] = observed
  }
  async function terminal(messageId) {
    const end = Math.min(workDeadline, now() + 120_000)
    while (now() < end) {
      await target()
      const q = await quality(), turn = q.turns.find(t => t.messageId === messageId)
      const page = await history()
      if (turn && !pending(turn)) return { turn, page }
      await wait(Math.min(1000, Math.max(1, end - now())))
    }
    throw new RoutingError('turn_timeout')
  }
  async function cleanupOwner() {
    await owned(true)
    check(same(memberKeys(await members(true)), initialKeys), 'cleanup_member_set_changed')
  }
  async function stopGroup() {
    if (!groupId || !scopeReady || report.messageAttempts === 0 || stopTried) return
    stopTried = true
    const cleanup = report.cleanup.group
    try {
      await target(true); await cleanupOwner()
      const before = await quality(true, true)
      check(report.cleanup.unobservedSubmission || before.turns.every(turn => initialTurns.has(turn.messageId) || roots.has(turn.messageId)), 'cleanup_concurrent_turn')
      cleanup.attempted = true
      try { const result = await request('/api/conversations/' + groupId + '/stop', 'POST', {}, true); cleanup.httpStatus = result.status; cleanup.acknowledged = result.status === 200 }
      catch { cleanup.error = 'group_routing_stop_unconfirmed' }
      const q = await quality(true, true)
      cleanup.noPendingRetry = q.turns.every(turn => !pending(turn))
      cleanup.turns = q.turns.map(turn => ({ messageId: UUID.test(turn.messageId ?? '') ? turn.messageId : null,
        status: TOKEN.test(turn.status ?? '') ? turn.status : null, error: TOKEN.test(turn.error ?? '') ? turn.error : null }))
    } catch (error) { cleanup.error = safeError(error) }
  }
  async function cancelUnexpected(messageId, trace) {
    const result = { messageId, taskId: null, runId: null, status: 'unconfirmed', cancelAttempted: false,
      executionStopConfirmed: false, machineEndAttempted: false, machineEndAcknowledged: false, independentProviderObservation: false }
    report.cleanup.delegations.push(result)
    try {
      check(roots.has(messageId), 'cleanup_message_scope')
      const events = trace.events?.filter(event => event.type === 'delegate' && event.outcome === 'succeeded') ?? []
      check(events.length === 1, 'cleanup_delegate_receipt')
      const event = events[0]
      check(UUID.test(event.taskId ?? '') && UUID.test(event.runId ?? '') && [...bots.values()].some(bot => bot.id === event.memberId)
        && same(trace.responders, [event.memberId]), 'cleanup_delegate_scope')
      const cleanupKey = event.taskId + ':' + event.runId
      if (cleanupAttempts.has(cleanupKey)) { report.cleanup.delegations.pop(); return }
      cleanupAttempts.add(cleanupKey)
      Object.assign(result, { taskId: event.taskId, runId: event.runId })
      await target(true); await cleanupOwner()
      const fresh = (await quality(true)).turns.find(turn => turn.messageId === messageId)
      check(fresh?.trace?.events?.some(row => row.type === 'delegate' && row.outcome === 'succeeded'
        && row.taskId === event.taskId && row.runId === event.runId && row.memberId === event.memberId), 'cleanup_receipt_changed')
      const state = await get('/api/factory/tasks/' + event.taskId, true), task = state?.task
      check(task?.id === event.taskId && task.userId === ownerId && task.botId === event.memberId && UUID.test(task.issueId ?? '')
        && UUID.test(task.sourceEventId ?? '') && UUID.test(task.attemptId ?? '') && Number.isSafeInteger(task.revision)
        && Array.isArray(state.attempts) && state.attempts.some(row => row.runId === event.runId && row.output?.requestEpoch === task.sourceEventId), 'cleanup_task_scope')
      const runIds = [...new Set(state.attempts.filter(row => row.output?.requestEpoch === task.sourceEventId && UUID.test(row.runId ?? '')).map(row => row.runId))].sort()
      check(runIds.length > 0 && runIds.length <= 48, 'cleanup_run_scope')
      const inspect = async () => {
        await target(true); await cleanupOwner()
        const latest = await get('/api/factory/tasks/' + task.id, true)
        check(latest?.task?.id === task.id && latest.task.userId === ownerId && latest.task.botId === event.memberId
          && latest.task.issueId === task.issueId && latest.task.sourceEventId === task.sourceEventId && Array.isArray(latest.attempts)
          && same([...new Set(latest.attempts.filter(row => row.output?.requestEpoch === task.sourceEventId && UUID.test(row.runId ?? '')).map(row => row.runId))].sort(), runIds), 'cleanup_epoch_changed')
        const runs = []
        for (const runId of runIds) {
          const run = (await get('/api/runs/' + runId + '/evidence', true))?.run, identity = run?.executionIdentity
          check(run?.id === runId && run.issueId === task.issueId && run.botId === event.memberId
            && identity?.requester === ownerId && identity.executionPrincipal === ownerId && identity.outputOwner === ownerId
            && identity.botId === event.memberId && identity.botOwner === ownerId && identity.workspaceId === workspaceId
            && identity.billingAccount?.runtime?.ownerId === ownerId && ['e2b', 'local_device'].includes(identity.billingAccount.runtime.kind), 'cleanup_identity_scope')
          runs.push({ runId, status: run.status, runtime: identity.billingAccount.runtime.kind })
        }
        return { task: latest.task, runs }
      }
      let current = await inspect()
      if (!['cancelled', 'revoked', 'failed'].includes(current.task.status)
        && !(current.task.status === 'passed' && ['approval', 'publish', 'monitor'].includes(current.task.stage))) {
        result.cancelAttempted = true
        const binding = { taskId: task.id, issueId: task.issueId, attemptId: current.task.attemptId,
          candidateId: current.task.candidateId, revision: current.task.revision }
        try { result.cancelStatus = (await request('/api/factory/tasks/' + task.id, 'POST', { binding, eventId: randomUUID(), action: 'cancel', reason: 'Stop this routing-only acceptance fixture and retain its evidence.' }, true)).status }
        catch { result.cancelStatus = null }
      }
      while (true) {
        current = await inspect()
        check(['cancelled', 'revoked', 'failed'].includes(current.task.status)
          || current.task.status === 'passed' && ['approval', 'publish', 'monitor'].includes(current.task.stage), 'cleanup_task_active')
        if (current.runs.every(run => ENDED.has(run.status))) break
        await wait(Math.min(2000, remaining(true)))
      }
      result.executionStopConfirmed = true; result.runs = []
      for (const run of current.runs) {
        const checked = await inspect()
        check(checked.runs.every(row => ENDED.has(row.status)) && (['cancelled', 'revoked', 'failed'].includes(checked.task.status)
          || checked.task.status === 'passed' && ['approval', 'publish', 'monitor'].includes(checked.task.stage)), 'cleanup_runs_active')
        const ended = { runId: run.runId, runtime: run.runtime, machineEndAttempted: false, machineEndAcknowledged: false }
        result.runs.push(ended)
        if (run.runtime === 'local_device') continue
        result.machineEndAttempted = true; ended.machineEndAttempted = true
        try {
          const response = await request('/api/threads/' + run.runId + '/machine', 'POST', { action: 'end' }, true)
          ended.httpStatus = response.status
          ended.machineEndAcknowledged = response.status === 200 && response.data?.runId === run.runId && response.data.state === 'ended'
        } catch { ended.error = 'group_routing_machine_end_unconfirmed' }
      }
      result.machineEndAcknowledged = result.runs.every(run => run.runtime === 'local_device' || run.machineEndAcknowledged)
      result.status = result.machineEndAcknowledged ? 'ended' : 'unconfirmed'
    } catch (error) { result.error = safeError(error) }
  }
  async function cleanupObservedDelegations() {
    if (!groupId || !scopeReady || report.messageAttempts === 0) return
    try {
      while (true) {
        await target(true); await cleanupOwner()
        const q = await quality(true, true), waiting = []
        for (const turn of q.turns) {
          if (initialTurns.has(turn.messageId)) continue
          const delegated = turn.trace?.events?.some(event => event.type === 'delegate' && event.outcome === 'succeeded')
          // A lost POST response does not establish which message the caller
          // created. Never guess a Task from a later group listing.
          if (!roots.has(turn.messageId)) { if (delegated) report.cleanup.unboundDelegateObserved = true; continue }
          if (!report.cases.some(row => row.messageId === turn.messageId && Array.isArray(row.decisions))) retainFailedTurn(turn)
          if (delegated) await cancelUnexpected(turn.messageId, turn.trace)
          // The host saves the route before delegation IO and its receipt
          // afterwards. Chat stop may occur during that IO; only wait for a
          // receipt here, within the existing cleanup deadline, never drain.
          else if (turn.trace?.action === 'delegate' && turn.status !== 'complete') waiting.push(turn.messageId)
        }
        report.cleanup.pendingDelegateReceiptIds = waiting
        if (!waiting.length) { report.cleanup.knownDelegationsReviewed = true; return }
        await wait(Math.min(2000, remaining(true)))
      }
    } catch (error) { report.cleanup.delegationError = safeError(error) }
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
      catch { report.cleanup.unobservedSubmission = true; throw new RoutingError('message_submission_unconfirmed') }
      if (sent.status === 201 && !UUID.test(sent.data?.id ?? '')) report.cleanup.unobservedSubmission = true
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
        retainFailedTurn(turn)
        await cancelUnexpected(sent.data.id, trace)
        throw new RoutingError('unexpected_delegation')
      }
      check(turn.status === 'complete' && trace.status === 'complete' && trace.policyVersion === 'group-contribution-v3', 'turn_not_complete')
      const measured = observation(turn)
      Object.assign(row, measured); row.decision = measured.primaryReceipt
      observedRoots.add(sent.data.id)
      lastTrace = trace
      check(expected.actions.includes(trace.action) && same(trace.responders, expected.ids), 'route_mismatch', false)
      check(row.wakes === expected.ids.length && new Set(wakeEvents.map(e => e.memberId)).size === row.wakes
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
    check(Array.isArray(q?.turns) && q.feedbackIsGroundTruth === false && q.costScope === 'routing-decision-chain'
      && q.turns.every(t => !pending(t)), 'group_not_idle')
    initialTurns = new Set(q.turns.map(t => t.messageId)); scopeReady = true
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
    let rejected
    try { rejected = await request('/api/conversations/' + groupId + '/messages', 'POST', { body, mentions }) }
    catch { report.cleanup.unobservedSubmission = true; throw new RoutingError('message_submission_unconfirmed') }
    if (rejected.status === 201 && !UUID.test(rejected.data?.id ?? '')) report.cleanup.unobservedSubmission = true
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
  finally {
    await restoreRole(); await restoreMember()
    await stopGroup(); await cleanupObservedDelegations()
  }
  const required = ['naturalSilence', 'answeredClosure', 'unrelatedSilence', 'coding', 'testing', 'sequentialIncremental', 'immediateRoleRouting', 'nonmemberMention']
  // Compatibility: this counts primary receipts/turns, not all provider requests.
  report.observedDecisionReceipts = observedRoots.size
  const measurements = [...report.cases.filter(row => Array.isArray(row.decisions)), ...report.failedTurns]
  const steps = [...new Map(measurements.flatMap(row => row.decisions).map((step, index) => [step.id ?? 'unknown-' + index, step])).values()]
  const paid = [...new Map(steps.filter(step => step.receipt).map(step => [step.receipt.providerGenerationId, step])).values()]
  const measuredRoots = new Set(measurements.map(row => row.messageId))
  const unknownTurns = [...roots].filter(id => !measuredRoots.has(id)).length + Number(report.cleanup.unobservedSubmission)
  report.providerCalls = { retainedSteps: steps.length, receipted: paid.length, unreceipted: steps.filter(step => !step.receipt).length,
    complete: !unknownTurns && report.failedTurns.length === 0 && measuredRoots.size === roots.size && steps.every(step => step.receipt) }
  report.knownCostUsd = paid.reduce((sum, step) => sum + (step.decisionCostUsd ?? 0), 0)
  report.unknownCostCalls = steps.filter(step => step.decisionCostUsd === null).length
  report.unobservedTurns = unknownTurns
  report.completeCostUsd = report.providerCalls.complete && report.unknownCostCalls === 0 ? report.knownCostUsd : null
  report.requiresScopeCleanup = report.errors.some(code => /submission_unconfirmed|turn_timeout|trace_shape/.test(code))
    || report.cleanup.unobservedSubmission || report.cleanup.unboundDelegateObserved
    || report.cleanup.delegations.some(d => d.status !== 'ended')
    || (report.messageAttempts > 0 && (!report.cleanup.group.acknowledged || !report.cleanup.group.noPendingRetry || !report.cleanup.knownDelegationsReviewed))
    || (roleAttempted && !report.cleanup.role.restored) || (memberAttempted && !report.cleanup.membership.restored)
  report.elapsedMs = Math.max(0, now() - started)
  if (report.cleanup.role.writeOutcome === 'unconfirmed' || report.cleanup.membership.writeOutcome === 'unconfirmed')
    report.errors.push('group_routing_cleanup_write_unconfirmed')
  report.status = required.every(k => report.coverage[k]) && report.errors.length === 0
    && report.cases.length === 8 && report.cases.every(c => c.status === 'passed')
    && report.cleanup.role.restored && report.cleanup.membership.restored && report.elapsedMs <= budgetMs
    && !report.requiresScopeCleanup ? 'passed' : 'failed'
  return report
}
