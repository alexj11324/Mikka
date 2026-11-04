import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { assertFlashTestModel } from '../test-model-policy.mjs'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { runGroupFactoryScenario } from './group-factory-acceptance.mjs'
import { GROUP_DECISION_PROTOCOL, groupDecisionPhases, groupDecisionFailures, groupDecisionTotals } from '../../lib/coordinator/group-decision-chain.ts'

/** A normal owner session and new, private synthetic fixtures. No SQL writes,
 * fabricated sessions, model fallback, existing-Bot edits or third-party posts. */
export async function runGroupProductionAcceptance({ env = process.env, fetchImpl = fetch, now = Date.now, wait = delay } = {}) {
  const email = env.MIKKA_TEST_ACCOUNT_EMAIL ?? env.SMOKE_OWNER_EMAIL
  const password = env.MIKKA_TEST_ACCOUNT_PASSWORD ?? env.SMOKE_OWNER_PASSWORD
  if ((!isSmokeAccountEmail(email) && email !== 'alexjiang20232024@gmail.com') || !password) throw Error('acceptance_account_required')
  const origin = new URL(env.GROUP_ACCEPTANCE_ORIGIN ?? 'https://app.aspectlylabs.com')
  if (origin.origin !== 'https://app.aspectlylabs.com' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw Error('acceptance_origin_rejected')
  if (!/^dpl_[A-Za-z0-9]+$/.test(env.GROUP_ACCEPTANCE_DEPLOYMENT ?? '') || !/^[a-f0-9]{40}$/.test(env.GROUP_ACCEPTANCE_REVISION ?? '')) throw Error('acceptance_fixed_deployment_required')
  const taskTimeoutMs = Number(env.GROUP_ACCEPTANCE_TASK_TIMEOUT_MS ?? 1200000)
  const stopTimeoutMs = Number(env.GROUP_ACCEPTANCE_STOP_TIMEOUT_MS ?? 180000)
  if (!Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs < 1000 || taskTimeoutMs > 3600000
    || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1000 || stopTimeoutMs > 300000) throw Error('acceptance_timeout_invalid')
  const report = { status: 'running', revision: env.GROUP_ACCEPTANCE_REVISION, deploymentId: env.GROUP_ACCEPTANCE_DEPLOYMENT,
    origin: origin.origin, startedAt: new Date().toISOString(), fixtureId: randomUUID(), bots: [], cases: [],
    scope: 'real group Decision API, public duties, Flash replies, feedback, Factory artifact acceptance, same-Task continuation and stop; no official-subscription claim' }
  let cookie = '', createdGroup = null
  const decisionObservations = new Map()
  async function request(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetchImpl(new URL(`/mikka${path}`, origin), { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { origin: origin.origin, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    const data = await response.json().catch(() => null)
    return { response, data }
  }
  const check = (condition, code) => { if (!condition) throw Error(code) }
  async function json(path, body, method) {
    const result = await request(path, body, method)
    check(result.response.ok, `acceptance_http_${result.response.status}`)
    return result.data
  }
  async function version() {
    const data = await json('/api/version')
    check(data?.build === report.deploymentId, 'acceptance_deployment_changed')
  }
  function observeDecisions(turn, quality) {
    const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value) ? value : null
    const receipt = value => value && token(value.executionId) && token(value.providerGenerationId)
      && value.modelId === 'openai/gpt-6-luna-decisions' && /^[a-f0-9]{64}$/.test(value.requestDigest ?? '')
      && Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.completedAt))
      && Date.parse(value.completedAt) >= Date.parse(value.startedAt)
      ? { executionId: value.executionId, providerGenerationId: value.providerGenerationId, modelId: value.modelId,
        requestDigest: value.requestDigest, startedAt: value.startedAt, completedAt: value.completedAt,
        imageDigests: (Array.isArray(value.imageDigests) ? value.imageDigests : []).filter(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)).slice(0,8),
        vision: value.vision === 'image-input-submitted' ? value.vision : 'no-image-input' } : null
    const raw = Array.isArray(turn.trace?.decisions) ? turn.trace.decisions : []
    const decisions = raw.slice(-64).map(step => ({ id: token(step.id), phase: groupDecisionPhases.includes(step.phase) ? step.phase : null,
      index: Number.isSafeInteger(step.index) && step.index >= 0 ? step.index : null,
      policyVersion: ['group-route-v0','group-contribution-v1','group-contribution-v2','group-contribution-v3'].includes(step.policyVersion) ? step.policyVersion : null,
      status: ['complete','invalid_decision','unavailable'].includes(step.status) ? step.status : 'unavailable',
      failure: groupDecisionFailures.includes(step.failure) ? step.failure : null,
      receipt: receipt(step.receipt), decisionCostUsd: typeof step.decisionCostUsd === 'number'
        && Number.isFinite(step.decisionCostUsd) && step.decisionCostUsd >= 0 ? step.decisionCostUsd : null }))
    const omitted = Number.isSafeInteger(turn.trace?.decisionsOmitted) && turn.trace.decisionsOmitted >= 0 ? turn.trace.decisionsOmitted : 0
    const totals = groupDecisionTotals(decisions, omitted + Math.max(0, raw.length - 64))
    const observation = { messageId: turn.messageId, decisionProtocol: turn.trace?.decisionProtocol === GROUP_DECISION_PROTOCOL ? GROUP_DECISION_PROTOCOL : null,
      primaryReceipt: receipt(turn.trace?.execution), decisions, decisionsOmitted: omitted,
      costScope: quality.costScope === 'routing-decision-chain' ? quality.costScope : null,
      ...totals, decisionCostUsd: decisions.length ? totals.decisionCostUsd : null }
    decisionObservations.set(turn.messageId, observation)
    report.decisionObservations = [...decisionObservations.values()]
    const all = report.decisionObservations.flatMap(item => item.decisions)
    report.decisionAccounting = { scope: 'routing-decision-chain', ...groupDecisionTotals(all,
      report.decisionObservations.reduce((sum,item) => sum + item.decisionsOmitted,0)) }
    report.decisionAccounting.unobservedTurns = report.decisionObservations.filter(item => !item.decisions.length).length
    if (!all.length || report.decisionAccounting.unobservedTurns) report.decisionAccounting.decisionCostUsd = null
    return observation
  }
  async function guard() {
    await version()
    // This guard runs before every prompt, even after the initial selection.
    for (const bot of report.bots) {
      const menu = await json(`/api/mobile/model?bot=${bot.id}`)
      check(menu?.current?.available === true && menu.current.modelId === bot.modelId, 'acceptance_model_changed')
      assertFlashTestModel(menu.current.modelId)
    }
  }
  async function download(path) {
    const url = new URL(path, origin)
    check(url.origin === origin.origin && !url.username && !url.password && !url.search && !url.hash
      && /^\/mikka\/api\/artifacts\/[a-f0-9-]{36}\/versions\/[1-9][0-9]*\/download$/.test(url.pathname), 'acceptance_artifact_url_rejected')
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { origin: origin.origin, 'cache-control': 'no-store', cookie } })
    check(response.ok && response.body, 'acceptance_artifact_download_failed')
    const chunks = [], reader = response.body.getReader()
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        check(size <= 65536, 'acceptance_artifact_oversized')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return Buffer.concat(chunks)
  }
  async function readTurn(groupId, messageId) {
    const timeout = now() + 120000
    while (now() < timeout) {
      const page = await json(`/api/conversations/${groupId}/messages`)
      const quality = await json(`/api/conversations/${groupId}/decisions?limit=100`)
      const turn = quality?.turns?.find(item => item.messageId === messageId)
      if (turn) observeDecisions(turn, quality)
      const pendingJudgment = turn?.status === 'failed' && turn.error === 'group_judgment_pending'
      if (turn && !pendingJudgment && ['complete','failed','stopped'].includes(turn.status)) {
        check(turn.status === 'complete' && turn.trace?.status === 'complete', `acceptance_turn_${turn.error && /^[a-z0-9_]{1,80}$/.test(turn.error) ? turn.error : 'failed'}`)
        return { turn, page, quality }
      }
      await wait(Math.min(1000, Math.max(1, timeout - now())))
    }
    throw Error('acceptance_turn_timeout')
  }
  async function stopFailedGroup() {
    if (!createdGroup) return
    const cleanup = { status: 'failed', conversationId: createdGroup.id, attempted: false, acknowledged: false,
      stoppedTurns: null, noPendingRetry: false, executionStopConfirmed: false, delegatedTaskIds: [], before: [], after: [] }
    report.groupCleanup = cleanup
    const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    const project = rows => rows.map(row => ({ messageId: uuid(row.messageId) ? row.messageId : null,
      status: ['queued','running','complete','failed','stopped'].includes(row.status) ? row.status : 'unknown',
      error: ['group_judgment_pending','stopped','group_lead_required'].includes(row.error) ? row.error : row.error == null ? null : 'other',
      traceStatus: ['pending','complete','failed','blocked','stopped'].includes(row.trace?.status) ? row.trace.status : 'unknown' }))
    try {
      await version()
      const session = await json('/api/auth/get-session')
      check(session?.user?.id === report.requesterId, 'acceptance_group_cleanup_owner')
      const groups = await json('/api/conversations?workspaceId=' + encodeURIComponent(report.workspaceId))
      const current = groups?.conversations?.find(group => group.id === createdGroup.id)
      check(current?.createdBy === report.requesterId && current.workspaceId === report.workspaceId
        && current.kind === 'group' && current.title === createdGroup.title
        && Number.isFinite(Date.parse(current.createdAt)) && Date.parse(current.createdAt) >= Date.parse(report.startedAt) - 5000,
      'acceptance_group_cleanup_scope')
      const bots = await json('/api/bots')
      check(Array.isArray(bots) && report.bots.length === 3 && report.bots.every(bot => uuid(bot.id)
        && bots.some(row => row.id === bot.id && row.ownerId === report.requesterId && row.workspaceId === report.workspaceId
          && row.name === 'Acceptance ' + bot.role + ' ' + report.fixtureId.slice(0,8))), 'acceptance_group_cleanup_bots')
      const members = (await json('/api/conversations/' + createdGroup.id + '/members'))?.members
      const expected = ['user:' + report.requesterId, ...report.bots.map(bot => 'bot:' + bot.id)].sort()
      check(Array.isArray(members) && JSON.stringify(members.map(member => member.memberType + ':' + member.id).sort()) === JSON.stringify(expected)
        && members.find(member => member.memberType === 'user' && member.id === report.requesterId)?.role === 'owner',
      'acceptance_group_cleanup_members')
      const before = await json('/api/conversations/' + createdGroup.id + '/decisions?limit=100')
      check(Array.isArray(before?.turns) && before.turns.length <= 100, 'acceptance_group_cleanup_trace')
      cleanup.before = project(before.turns)
      for (const turn of before.turns) observeDecisions(turn, before)
      cleanup.delegatedTaskIds = [...new Set(before.turns.flatMap(row => (row.trace?.events ?? [])
        .filter(event => event.type === 'delegate' && uuid(event.taskId)).map(event => event.taskId)))]
      await version()
      cleanup.attempted = true
      try {
        const result = await request('/api/conversations/' + createdGroup.id + '/stop', {}, 'POST')
        cleanup.acknowledged = result.response.status === 200 && Number.isSafeInteger(result.data?.stopped)
          && result.data.stopped >= 0 && result.data.stopped <= before.turns.length
        cleanup.stoppedTurns = cleanup.acknowledged ? result.data.stopped : null
      } catch { cleanup.error = 'acceptance_group_stop_unconfirmed' }
      // Observe an unknown write once without replaying it. Unlike message
      // history, the decisions endpoint never drains pending work.
      const after = await json('/api/conversations/' + createdGroup.id + '/decisions?limit=100')
      check(Array.isArray(after?.turns), 'acceptance_group_cleanup_trace')
      cleanup.after = project(after.turns)
      for (const turn of after.turns) observeDecisions(turn, after)
      cleanup.noPendingRetry = after.turns.every(row => !['queued','running'].includes(row.status) && row.error !== 'group_judgment_pending')
      cleanup.status = cleanup.acknowledged && cleanup.noPendingRetry ? 'stopped'
        : cleanup.noPendingRetry ? 'stop-observed-unconfirmed' : 'failed'
    } catch (error) {
      cleanup.error = error instanceof Error && /^acceptance_[a-z0-9_]+$/.test(error.message) ? error.message : 'acceptance_group_cleanup_failed'
    }
  }
  async function scenario(groupId, name, body, mentions, expected) {
    await guard()
    const message = await json(`/api/conversations/${groupId}/messages`, { body, mentions })
    check(typeof message?.id === 'string', 'acceptance_message_missing')
    const evidence = { name, messageId: message.id, status: 'running' }
    report.cases.push(evidence)
    const { turn, page, quality } = await readTurn(groupId, message.id)
    const trace = turn.trace, count = type => trace.events.filter(event => event.type === type).length
    const observed = observeDecisions(turn, quality)
    const replies = page.messages.filter(item => item.replyToId === message.id && item.authorType !== 'user')
    Object.assign(evidence, { action: trace.action, responders: trace.responders, wakes: count('wake'), generations: count('generate'), publications: count('publish'), decision: trace.execution,
      decisionCostUsd: observed.decisionCostUsd, decisionLatencyMs: observed.decisionLatencyMs,
      decisionProtocol: observed.decisionProtocol, decisions: observed.decisions, decisionsOmitted: observed.decisionsOmitted,
      decisionCalls: observed.decisionCalls, decisionCost: observed.decisionCost, costScope: observed.costScope })
    check(expected.actions.includes(trace.action), 'acceptance_action_mismatch')
    assert.deepEqual(trace.responders, expected.responders, 'acceptance_responder_mismatch')
    check(count('wake') === expected.wakes && count('generate') === expected.generations && count('publish') === expected.publications && replies.length === expected.publications, 'acceptance_side_effect_mismatch')
    if (!mentions.length) check(Boolean(trace.execution?.executionId && trace.execution?.providerGenerationId && trace.execution?.requestDigest), 'acceptance_decision_receipt_missing')
    check(observed.decisionProtocol === GROUP_DECISION_PROTOCOL && observed.costScope === 'routing-decision-chain'
      && observed.decisions.length > 0 && observed.primaryReceipt
      && observed.decisions.some(step => step.index === 0 && step.receipt?.executionId === observed.primaryReceipt.executionId),
    'acceptance_decision_chain_missing')
    check(quality.feedbackIsGroundTruth === false && trace.policyVersion === 'group-contribution-v3', 'acceptance_trace_contract')
    // History reads restart only genuinely pending turns. The same root does
    // not produce more generations or publications when the client polls again.
    const reread = await readTurn(groupId, message.id)
    assert.deepEqual(reread.turn.trace.events, trace.events, 'acceptance_duplicate_effect')
    evidence.status = 'pass'
    return message.id
  }
  try {
    await version()
    const login = await request('/api/auth/sign-in/email', { email, password })
    check(login.response.status === 200, 'acceptance_sign_in_failed')
    cookie = login.response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    check(Boolean(cookie), 'acceptance_session_missing')
    const session = await json('/api/auth/get-session')
    check(session?.user?.email?.toLowerCase() === email.toLowerCase(), 'acceptance_session_identity')
    check(typeof session.user.id === 'string' && session.user.id.length > 0, 'acceptance_session_identity')
    report.requesterId = session.user.id
    const ownBots = await json('/api/bots')
    check(Array.isArray(ownBots) && ownBots.length > 0, 'acceptance_workspace_missing')
    const workspaceId = ownBots[0].workspaceId
    report.workspaceId = workspaceId
    for (const [name, publicRole] of [['UI', '负责界面设计、用户交互与可用性。'], ['Coding', '负责代码实现与修复软件缺陷。'], ['Testing', '负责测试设计、回归测试与质量验证。']]) {
      const bot = await json('/api/bots', { name: `Acceptance ${name} ${report.fixtureId.slice(0,8)}` })
      check(bot?.workspaceId === workspaceId && typeof bot.id === 'string', 'acceptance_bot_scope')
      const fixture = { id: bot.id, role: name, modelId: null }
      report.bots.push(fixture)
      await json(`/api/bots/${bot.id}`, { publicRole }, 'PATCH')
      const profile = await json(`/api/bots/${bot.id}`)
      check(profile?.publicRole === publicRole, 'acceptance_public_role_not_persisted')
      const menu = await json(`/api/mobile/model?bot=${bot.id}`)
      // Discover only the normal owner's already-authorized native options.
      // This does not select or invoke a subscription during Flash acceptance.
      report.subscriptionOptions ??= (menu?.groups ?? []).filter(group => group.kind === 'subscription')
        .flatMap(group => group.options.map(option => ({ id: option.id, provider: option.provider, modelId: option.modelId })))
      const choices = (menu?.groups ?? []).filter(group => group.kind === 'apiKey').flatMap(group => group.options)
      const option = choices.find(item => { try { assertFlashTestModel(item.modelId); return item.provider === 'deepseek' } catch { return false } })
      check(Boolean(option), 'acceptance_flash_model_unavailable')
      assertFlashTestModel(option.modelId)
      const selected = await json('/api/mobile/model', { bot: bot.id, id: option.id }, 'PUT')
      check(selected?.current?.modelId === option.modelId && selected.current.available === true, 'acceptance_model_not_selected')
      fixture.modelId = option.modelId
    }
    const title = 'Proactive acceptance ' + report.fixtureId.slice(0,8)
    const created = await request('/api/conversations', { workspaceId, title, members: report.bots.map(bot => ({ memberType: 'bot', memberId: bot.id })) })
    check(created.response.status === 201 && /^[a-f0-9-]{36}$/.test(created.data?.id ?? '') && created.data?.title === title, 'acceptance_group_creation_receipt')
    const group = created.data
    createdGroup = { id: group.id, title }
    report.conversationId = group.id
    const [ui, , testing] = report.bots
    await scenario(group.id, 'useful-silence', '今天午饭不错。这只是闲聊，不需要回复，也不需要执行任何任务。', [], { actions: ['ignore','observe'], responders: [], wakes: 0, generations: 0, publications: 0 })
    const help = await scenario(group.id, 'duty-matched-primary', '请负责UI设计的同事回答：保存按钮在请求进行中应该有什么反馈？只需一句交互建议，不要执行任务。', [], { actions: ['reply'], responders: [ui.id], wakes: 1, generations: 1, publications: 1 })
    await scenario(group.id, 'explicit-mention', '请用一句话建议如何测试空值输入。只回答建议，不执行任务。', [{ memberType: 'bot', memberId: testing.id }], { actions: ['reply'], responders: [testing.id], wakes: 1, generations: 1, publications: 1 })
    const feedback = await json(`/api/conversations/${group.id}/decisions`, { messageId: help, kind: 'helpful', targetId: ui.id })
    check(feedback.recorded === true && feedback.source === 'human_explicit' && feedback.policyChanged === false, 'acceptance_feedback_not_persisted')
    const forgery = await request(`/api/conversations/${group.id}/decisions`, { messageId: help, kind: 'helpful', source: 'agent_evaluation' })
    check(forgery.response.status === 422, 'acceptance_feedback_source_forgeable')
    await runGroupFactoryScenario({ report, json, readTurn, guard, download, timeoutMs: taskTimeoutMs, stopTimeoutMs })
    const finalQuality = await json('/api/conversations/' + group.id + '/decisions?limit=100')
    for (const turn of finalQuality.turns ?? []) observeDecisions(turn, finalQuality)
    await version()
    report.status = 'pass'
    return report
  } catch (error) {
    report.status = 'fail'
    for (const item of report.cases) if (item.status === 'running') item.status = 'fail'
    report.error = error instanceof Error && /^acceptance_[a-z0-9_]+$/.test(error.message) ? error.message : 'acceptance_assertion_failed'
    await stopFailedGroup()
    return report
  } finally {
    report.finishedAt = new Date().toISOString()
    // Keep the synthetic history and receipts for review. Only this transient
    // login session is ended; unrelated account sessions are untouched.
    if (cookie) {
      try { report.sessionEnded = (await request('/api/auth/sign-out', {}, 'POST')).response.status === 200 }
      catch { report.sessionEnded = false }
      if (!report.sessionEnded) { report.status = 'fail'; report.error ??= 'acceptance_session_cleanup_failed' }
    }
    cookie = ''
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try { report = await runGroupProductionAcceptance() }
  catch (error) { report = { status: 'fail', error: error instanceof Error && /^acceptance_[a-z0-9_]+$/.test(error.message) ? error.message : 'acceptance_preflight_failed' } }
  mkdirSync('group-production-acceptance', { recursive: true })
  writeFileSync('group-production-acceptance/results.json', `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
  if (report.status !== 'pass') process.exitCode = 1
}
