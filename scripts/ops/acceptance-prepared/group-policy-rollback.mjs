import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const ORIGIN = 'https://app.aspectlylabs.com'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const TOKEN = /^[A-Za-z0-9_.:-]{1,200}$/
const HASH = /^[a-f0-9]{64}$/
const POLICIES = ['group-route-v0', 'group-contribution-v1']
const FLASH = new Set(['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek/deepseek-flash', 'deepseek/deepseek-v4.1-flash'])
const ROLES = [['UI', '负责界面设计、用户交互与可用性。'], ['Coding', '负责代码实现与修复软件缺陷。'], ['Testing', '负责测试设计、回归测试与质量验证。']]
const ENDED = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled'])
const FAILURES = new Set(['unavailable', 'missing_or_refused', 'wrong_answer_type', 'uncertain', 'choice_outside_contract', 'receipt_missing', 'duplicate_receipt', 'mention_requires_intervention', 'reporter_unavailable', 'call_budget_exhausted', 'invalid_response', 'members_unavailable'])
const digest = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
class PolicyError extends Error { constructor(code) { super('policy_acceptance_' + code) } }
const check = (ok, code) => { if (!ok) throw new PolicyError(code) }
const safeError = error => error instanceof PolicyError ? error.message : 'policy_acceptance_unconfirmed'
const pending = turn => ['queued', 'running'].includes(turn.status) || turn.status === 'failed' && turn.error === 'group_judgment_pending'

/** Prepared only; no invocation on import and no PostHog API or credentials.
 * The caller owns normal login and temporary Flash-key cleanup. This module
 * creates its own fixture through normal APIs and reports only routing scope. */
export async function runGroupPolicyRollback({ owner, verifyTarget, assertFlashTestModel, decisionModelId,
  onCheckpoint, now = Date.now, wait = delay, budgetMs = 555_000 } = {}) {
  check(typeof owner?.request === 'function' && typeof verifyTarget === 'function'
    && typeof assertFlashTestModel === 'function', 'normal_transport_required')
  check(typeof onCheckpoint === 'function', 'operator_checkpoint_required')
  check(decisionModelId === 'openai/gpt-6-luna-decisions', 'decision_model_required')
  check(Number.isSafeInteger(budgetMs) && budgetMs >= 1000 && budgetMs <= 600_000, 'budget_invalid')
  const started = now(), deadline = started + budgetMs
  const workDeadline = deadline - Math.min(180_000, Math.floor(budgetMs / 3))
  const fixtureId = randomUUID(), prefix = fixtureId.slice(0, 8), roots = new Set(), seenSteps = new Set(), seenExecutions = new Set(), seenGenerations = new Set(), cleanupAttempts = new Set()
  const report = { schemaVersion: 1, scope: 'manual-group-policy-roundtrip', status: 'failed', fixtureId,
    startedAt: new Date(started).toISOString(), finishedAt: null, conversationId: null, requesterId: null, workspaceId: null,
    bots: [], messageAttempts: 0, maximumMessages: 8, budgetMs, phases: [], observations: [], failedTurns: [], errors: [],
    cleanup: { group: { attempted: false, acknowledged: false, noPendingRetry: false }, machines: [], unobservedSubmission: false,
      knownDelegationsReviewed: false, unboundDelegateObserved: false },
    policyChangedByRunner: false, manualFlagControlVerified: false, replayPerformed: false, fixtureRetained: true,
    callerSessionAndCredentialCleanupRequired: true, independentProviderObservation: false }
  let ownerId, workspaceId, group, stopTried = false
  const bots = []
  function remaining(cleanup = false) {
    const ms = (cleanup ? deadline : workDeadline) - now()
    check(ms > 0, 'budget_exhausted')
    return Math.max(1, Math.min(15_000, Math.floor(ms)))
  }
  async function request(path, method = 'GET', body, cleanup = false) {
    const response = await owner.request(path, { method, redirect: 'error', signal: AbortSignal.timeout(remaining(cleanup)),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const text = await response.text()
    check(Buffer.byteLength(text) <= 1024 * 1024, 'body_limit')
    let data
    try { data = JSON.parse(text) } catch { throw new PolicyError('response_shape') }
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
    const expired = new Promise((_, reject) => { abort = () => reject(new PolicyError('target_timeout')); signal.addEventListener('abort', abort, { once: true }) })
    try { await Promise.race([Promise.resolve().then(() => verifyTarget({ signal })), expired]) }
    finally { signal.removeEventListener('abort', abort) }
    remaining(cleanup)
  }
  async function checkpoint(value) {
    const signal = AbortSignal.timeout(remaining())
    let abort
    const expired = new Promise((_, reject) => { abort = () => reject(new PolicyError('checkpoint_timeout')); signal.addEventListener('abort', abort, { once: true }) })
    try { await Promise.race([Promise.resolve().then(() => onCheckpoint(value)), expired]) }
    finally { signal.removeEventListener('abort', abort) }
  }
  async function owned(cleanup = false) {
    check((await get('/api/auth/get-session', cleanup))?.user?.id === ownerId, 'owner_changed')
    const visible = await get('/api/bots', cleanup)
    check(Array.isArray(visible) && bots.every(bot => visible.some(row => row.id === bot.id && row.ownerId === ownerId
      && row.workspaceId === workspaceId && row.name === bot.name)), 'fixture_owner_changed')
    if (!group) return
    const page = await get('/api/conversations?workspaceId=' + workspaceId, cleanup)
    const live = page?.conversations?.find(row => row.id === group.id)
    check(live?.createdBy === ownerId && live.workspaceId === workspaceId && live.title === group.title && live.kind === 'group'
      && Number.isFinite(Date.parse(live.createdAt)) && Date.parse(live.createdAt) >= started - 5000, 'group_owner_changed')
    const members = (await get('/api/conversations/' + group.id + '/members', cleanup))?.members
    check(Array.isArray(members) && members.some(row => row.id === ownerId && row.memberType === 'user' && row.role === 'owner')
      && same(members.map(row => row.memberType + ':' + row.id).sort(), ['user:' + ownerId, ...bots.map(bot => 'bot:' + bot.id)].sort()), 'member_set_changed')
  }
  async function quality(cleanup = false) {
    const value = await get('/api/conversations/' + group.id + '/decisions?limit=100', cleanup)
    check(Array.isArray(value?.turns) && value.feedbackIsGroundTruth === false && value.costScope === 'routing-decision-chain', 'trace_contract')
    return value
  }
  async function guard() {
    await target(); await owned()
    const q = await quality()
    check(q.turns.every(turn => roots.has(turn.messageId) && !pending(turn)), 'group_not_idle')
    for (const bot of bots) {
      const current = (await get('/api/mobile/model?bot=' + bot.id))?.current
      check(current?.kind === 'apiKey' && current.provider === 'deepseek' && current.available === true
        && current.modelId === bot.modelId && FLASH.has(current.modelId), 'flash_selection_changed')
      assertFlashTestModel(current.modelId)
    }
  }
  function receipt(value) {
    check(value?.modelId === decisionModelId && TOKEN.test(value.executionId ?? '') && TOKEN.test(value.providerGenerationId ?? '')
      && HASH.test(value.requestDigest ?? '') && Array.isArray(value.imageDigests) && value.imageDigests.length === 0
      && Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.completedAt))
      && Date.parse(value.completedAt) >= Date.parse(value.startedAt), 'receipt_missing')
    return { executionId: value.executionId, modelId: value.modelId, providerGenerationId: value.providerGenerationId,
      requestDigest: value.requestDigest, startedAt: value.startedAt, completedAt: value.completedAt }
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
        check(!seenExecutions.has(paid.executionId) && !seenGenerations.has(paid.providerGenerationId), 'receipt_reused')
        seenExecutions.add(paid.executionId); seenGenerations.add(paid.providerGenerationId)
      }
      const amount = typeof step.decisionCostUsd === 'number' && Number.isFinite(step.decisionCostUsd) && step.decisionCostUsd >= 0 ? step.decisionCostUsd : null
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
    report.failedTurns.push({ messageId: UUID.test(turn?.messageId ?? '') ? turn.messageId : null,
      status: ['queued', 'running', 'failed', 'complete'].includes(turn?.status) ? turn.status : null,
      policyVersion: POLICIES.includes(trace?.policyVersion) ? trace.policyVersion : null,
      primaryReceipt: safeReceipt(trace?.execution), decisions: steps,
      costScope: 'routing-decision-chain', completeCostUsd: null,
      knownCostUsd: steps.length ? [...uniquePaid.values()].reduce((sum, step) => sum + (step.decisionCostUsd ?? 0), 0) : null,
      retainedSteps: steps.length, providerCallsComplete: false })
  }
  async function terminal(messageId) {
    const end = Math.min(workDeadline, now() + 120_000)
    while (now() < end) {
      await target()
      const q = await quality(), turn = q.turns.find(row => row.messageId === messageId)
      check(q.turns.every(row => roots.has(row.messageId)), 'foreign_turn')
      const page = await get('/api/conversations/' + group.id + '/messages?limit=100')
      check(Array.isArray(page?.messages), 'message_shape')
      if (turn && !pending(turn)) return { turn, page }
      await wait(Math.min(1000, Math.max(1, end - now())))
    }
    throw new PolicyError('turn_timeout')
  }
  async function stopGroup() {
    if (!group || stopTried) return
    stopTried = true
    const cleanup = report.cleanup.group
    try {
      await target(true); await owned(true)
      cleanup.attempted = true
      try { const result = await request('/api/conversations/' + group.id + '/stop', 'POST', {}, true); cleanup.httpStatus = result.status; cleanup.acknowledged = result.status === 200 }
      catch { cleanup.error = 'policy_acceptance_stop_unconfirmed' }
      const q = await quality(true)
      cleanup.noPendingRetry = q.turns.every(turn => !pending(turn))
      cleanup.turns = q.turns.map(turn => ({ messageId: UUID.test(turn.messageId ?? '') ? turn.messageId : null,
        status: TOKEN.test(turn.status ?? '') ? turn.status : null, error: TOKEN.test(turn.error ?? '') ? turn.error : null }))
    } catch (error) { cleanup.error = safeError(error) }
  }
  async function endUnexpected(messageId, trace) {
    const result = { messageId, taskId: null, runId: null, status: 'unconfirmed', cancelAttempted: false,
      executionStopConfirmed: false, machineEndAttempted: false, machineEndAcknowledged: false, independentProviderObservation: false }
    report.cleanup.machines.push(result)
    try {
      check(roots.has(messageId), 'cleanup_message_scope')
      const events = trace.events?.filter(event => event.type === 'delegate' && event.outcome === 'succeeded') ?? []
      check(events.length === 1, 'cleanup_delegate_receipt')
      const event = events[0]
      check(UUID.test(event.taskId ?? '') && UUID.test(event.runId ?? '') && bots.some(bot => bot.id === event.memberId), 'cleanup_delegate_scope')
      const cleanupKey = event.taskId + ':' + event.runId
      if (cleanupAttempts.has(cleanupKey)) { report.cleanup.machines.pop(); return }
      cleanupAttempts.add(cleanupKey)
      Object.assign(result, { taskId: event.taskId, runId: event.runId })
      await target(true); await owned(true)
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
        await target(true); await owned(true)
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
        } catch { ended.error = 'policy_acceptance_machine_end_unconfirmed' }
      }
      result.machineEndAcknowledged = result.runs.every(run => run.runtime === 'local_device' || run.machineEndAcknowledged)
      result.status = result.machineEndAcknowledged ? 'ended' : 'unconfirmed'
    } catch (error) { result.error = safeError(error) }
  }
  async function cleanupObservedDelegations() {
    if (!group) return
    try {
      while (true) {
        await target(true); await owned(true)
        const q = await quality(true), waiting = []
        for (const turn of q.turns) {
          const delegated = turn.trace?.events?.some(event => event.type === 'delegate' && event.outcome === 'succeeded')
          // A lost POST response does not establish which message the caller
          // created. Never guess a Task from a later group listing.
          if (!roots.has(turn.messageId)) { if (delegated) report.cleanup.unboundDelegateObserved = true; continue }
          if (!report.observations.some(row => row.messageId === turn.messageId)
            && !report.failedTurns.some(row => row.messageId === turn.messageId)) retainFailedTurn(turn)
          if (delegated) await endUnexpected(turn.messageId, turn.trace)
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
  try {
    await target()
    const session = await get('/api/auth/get-session')
    check(TOKEN.test(session?.user?.id ?? ''), 'owner_required')
    ownerId = session.user.id; report.requesterId = ownerId
    for (const [role, publicRole] of ROLES) {
      await target()
      const name = 'Policy acceptance ' + role + ' ' + prefix
      const created = await request('/api/bots', 'POST', { name })
      check(created.status === 201 && UUID.test(created.data?.id ?? '') && UUID.test(created.data?.workspaceId ?? '')
        && created.data.name === name && created.data.ownerId === ownerId, 'bot_creation_receipt')
      workspaceId ??= created.data.workspaceId
      check(created.data.workspaceId === workspaceId, 'workspace_changed')
      const bot = { id: created.data.id, name, role, modelId: null }; bots.push(bot); report.bots.push({ id: bot.id, role, modelId: null })
      report.workspaceId = workspaceId
      await owned()
      check((await request('/api/bots/' + bot.id, 'PATCH', { publicRole })).status === 200
        && (await get('/api/bots/' + bot.id))?.publicRole === publicRole, 'role_write_unconfirmed')
      const menu = await get('/api/mobile/model?bot=' + bot.id)
      const option = (menu?.groups ?? []).filter(row => row.kind === 'apiKey').flatMap(row => row.options ?? [])
        .find(row => row.provider === 'deepseek' && FLASH.has(row.modelId) && typeof row.id === 'string' && row.id.startsWith('apikey:'))
      check(option, 'flash_unavailable'); assertFlashTestModel(option.modelId)
      check((await request('/api/mobile/model', 'PUT', { bot: bot.id, id: option.id })).status === 200, 'model_write_unconfirmed')
      const selected = (await get('/api/mobile/model?bot=' + bot.id))?.current
      check(selected?.id === option.id && selected.kind === 'apiKey' && selected.provider === 'deepseek'
        && selected.available === true && selected.modelId === option.modelId, 'model_readback')
      bot.modelId = option.modelId; report.bots.at(-1).modelId = option.modelId
    }
    const title = 'Policy acceptance ' + prefix
    const created = await request('/api/conversations', 'POST', { workspaceId, title, members: bots.map(bot => ({ memberType: 'bot', memberId: bot.id })) })
    check(created.status === 201 && UUID.test(created.data?.id ?? '') && created.data.title === title, 'group_creation_receipt')
    group = { id: created.data.id, title }; report.conversationId = group.id
    await guard()
    for (const policyVersion of POLICIES) {
      const phase = { expectedPolicyVersion: policyVersion, status: 'awaiting-observation', messageIds: [] }; report.phases.push(phase)
      for (let attempt = 0; attempt < 4; attempt++) {
        if (report.messageAttempts) { check(workDeadline - now() >= 61_000, 'budget_exhausted'); await wait(61_000) }
        await guard(); check(report.messageAttempts < 8, 'message_limit')
        const body = `验收标记 ${fixtureId}-${report.messageAttempts + 1}。请从UI交互角度，用一句话说明保存按钮在请求进行中应显示什么反馈。这是讨论，不创建任务。`
        report.messageAttempts++
        let sent
        try { sent = await request('/api/conversations/' + group.id + '/messages', 'POST', { body, mentions: [{ memberType: 'bot', memberId: bots[0].id }] }) }
        catch { report.cleanup.unobservedSubmission = true; throw new PolicyError('message_submission_unconfirmed') }
        if (sent.status !== 201 || !UUID.test(sent.data?.id ?? '')) {
          report.cleanup.unobservedSubmission = true
          throw new PolicyError('message_submission_rejected')
        }
        const messageId = sent.data.id; roots.add(messageId); phase.messageIds.push(messageId)
        const { turn, page } = await terminal(messageId), trace = turn.trace
        if (trace?.action === 'delegate' || trace?.events?.some(event => event.type === 'delegate')) {
          retainFailedTurn(turn)
          await stopGroup(); await endUnexpected(messageId, trace); throw new PolicyError('unexpected_delegate')
        }
        let observed
        try { observed = observation(turn) }
        catch (error) { retainFailedTurn(turn); throw error }
        report.observations.push(observed)
        const events = trace.events, replies = page.messages.filter(row => row.replyToId === messageId && row.authorType !== 'user')
        check(Array.isArray(events) && trace.action === 'reply' && same(trace.responders, [bots[0].id])
          && ['wake', 'generate', 'publish'].every(type => events.filter(event => event.type === type).length === 1)
          && events.every(event => ['wake', 'generate', 'publish'].includes(event.type) && event.memberId === bots[0].id)
          && replies.length === 1 && replies[0].authorType === 'bot' && replies[0].authorId === bots[0].id
          && events.find(event => event.type === 'publish').contentDigest === digest(String(replies[0].body).trim()), 'unexpected_effects')
        const reread = (await quality()).turns.find(row => row.messageId === messageId)
        check(reread?.status === 'complete' && same(reread.trace?.events, events), 'effect_changed')
        if (observed.policyVersion !== policyVersion) continue
        phase.status = 'observed'; phase.observedMessageId = messageId
        await checkpoint({ type: policyVersion === POLICIES[0] ? 'baseline_observed' : 'candidate_observed', policyVersion, messageId,
          nextManualAction: policyVersion === POLICIES[0] ? 'set_existing_flag_inactive' : 'none' })
        break
      }
      check(phase.status === 'observed', 'policy_not_observed')
    }
    report.status = 'passed'
  } catch (error) { report.errors.push(safeError(error)) }
  finally {
    await stopGroup()
    // Group stop only fences chat turns. A Factory receipt may already exist
    // when the awaited turn times out, so review the confirmed message set
    // again even when terminal() did not return to the normal scenario path.
    await cleanupObservedDelegations()
    if (!report.cleanup.group.acknowledged || !report.cleanup.group.noPendingRetry || report.cleanup.unobservedSubmission
      || !report.cleanup.knownDelegationsReviewed || report.cleanup.unboundDelegateObserved
      || report.cleanup.machines.some(row => row.status !== 'ended')) report.status = 'failed'
    report.finishedAt = new Date(now()).toISOString()
  }
  return report
}

/** Reuses the existing normal Smoke login and temporary-key helper. The owner
 * manually switches PostHog outside this process. No production workflow is
 * installed by this draft; calling this export is a separately reviewed step. */
export async function runGroupPolicyRollbackBundle({ env = process.env, fetchImpl = fetch, repo = process.cwd(), dependencies,
  onCheckpoint, now = Date.now, wait = delay,
  verifySource = () => { check(!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim(), 'source_dirty'); return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() } } = {}) {
  const revision = env.GROUP_ACCEPTANCE_REVISION, deploymentId = env.GROUP_ACCEPTANCE_DEPLOYMENT
  check(/^[a-f0-9]{40}$/.test(revision ?? '') && /^dpl_[A-Za-z0-9]+$/.test(deploymentId ?? ''), 'fixed_deployment_required')
  check(!env.GROUP_ACCEPTANCE_ORIGIN || env.GROUP_ACCEPTANCE_ORIGIN === ORIGIN, 'origin_rejected')
  check(verifySource() === revision, 'source_revision_mismatch')
  const started = now(), deadline = started + 600_000
  const report = { schemaVersion: 1, scope: 'manual-group-policy-roundtrip', status: 'failed', revision, deploymentId,
    group: null, error: null, credentialCleanup: null, sessionCleanup: {}, policyChangedByRunner: false,
    manualFlagControlVerified: false, cloudCredentialCreated: false }
  const module = path => import(pathToFileURL(resolve(repo, path)).href)
  const api = dependencies ?? Object.assign({}, ...await Promise.all([module('scripts/ops/proactive-test-credentials.mjs'), module('scripts/test-model-policy.mjs'), module('lib/smoke-account.ts'), module('lib/coordinator/decision.ts')]))
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  check(api.isSmokeAccountEmail(email) && password, 'normal_account_required')
  let cookie = '', cleanupReceipt
  const transport = scope => {
    const record = report.sessionCleanup[scope] = { loginStatus: null, logoutStatus: null }
    return async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      check(url.origin === ORIGIN && !url.username && !url.password && !url.hash && url.pathname.startsWith('/mikka/'), 'transport_origin_rejected')
      check(now() < deadline, 'budget_exhausted')
      const signal = AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - now())))
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal })
      if (url.pathname === '/mikka/api/auth/sign-in/email' && init.method === 'POST') record.loginStatus = response.status
      if (url.pathname === '/mikka/api/auth/sign-out' && init.method === 'POST') record.logoutStatus = response.status
      return response
    }
  }
  const credentialTransport = transport('temporaryCredentials'), ownerTransport = transport('policyFixture')
  const owner = { request: (path, init = {}) => ownerTransport(ORIGIN + '/mikka' + path, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), origin: ORIGIN, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}) } }) }
  const verifyTarget = async ({ signal } = {}) => {
    check(verifySource() === revision, 'source_revision_mismatch')
    const response = await owner.request('/api/version', { method: 'GET', signal })
    check(response.status === 200 && (await response.json())?.build === deploymentId, 'deployment_changed')
  }
  try {
    await verifyTarget()
    await api.withTemporaryFlashCredential(async cleanup => {
      cleanupReceipt = cleanup
      try {
        await verifyTarget()
        const login = await owner.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
        check(login.status === 200, 'login_failed')
        cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
        const response = await owner.request('/api/auth/get-session', { method: 'GET' }), session = await response.json()
        check(cookie && response.status === 200 && session?.user?.email?.toLowerCase() === email.toLowerCase(), 'session_identity')
        const budgetMs = Math.min(555_000, deadline - now() - 45_000)
        check(budgetMs >= 1000, 'budget_exhausted')
        report.group = await runGroupPolicyRollback({ owner, verifyTarget, assertFlashTestModel: api.assertFlashTestModel,
          decisionModelId: api.DECISION_MODEL, onCheckpoint, now, wait, budgetMs })
      } finally {
        if (cookie) { try { await owner.request('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) } catch {} }
        cookie = ''
      }
    }, { env: { ...env, MIKKA_TEST_ACCOUNT_EMAIL: email, MIKKA_TEST_ACCOUNT_PASSWORD: password }, fetchImpl: credentialTransport, cloudExecution: false })
    await verifyTarget()
  } catch (error) { report.error = safeError(error) }
  finally {
    cookie = ''
    report.credentialCleanup = cleanupReceipt ? { created: cleanupReceipt.created === true, removed: cleanupReceipt.removed === true } : null
    report.status = !report.error && report.group?.status === 'passed' && cleanupReceipt && (!cleanupReceipt.created || cleanupReceipt.removed)
      && Object.values(report.sessionCleanup).every(session => session.loginStatus === 200 && session.logoutStatus === 200) ? 'passed' : 'failed'
  }
  return report
}
