import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { assertFlashTestModel } from '../test-model-policy.mjs'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { runGroupFactoryScenario } from './group-factory-acceptance.mjs'

/** A normal owner session and new, private synthetic fixtures. No SQL writes,
 * fabricated sessions, model fallback, existing-Bot edits or third-party posts. */
export async function runGroupProductionAcceptance({ env = process.env, fetchImpl = fetch } = {}) {
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
  let cookie = ''
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
    const timeout = Date.now() + 120000
    while (Date.now() < timeout) {
      const page = await json(`/api/conversations/${groupId}/messages`)
      const quality = await json(`/api/conversations/${groupId}/decisions?limit=100`)
      const turn = quality?.turns?.find(item => item.messageId === messageId)
      if (turn && ['complete','failed','stopped'].includes(turn.status)) {
        check(turn.status === 'complete' && turn.trace?.status === 'complete', `acceptance_turn_${turn.error && /^[a-z0-9_]{1,80}$/.test(turn.error) ? turn.error : 'failed'}`)
        return { turn, page, quality }
      }
      await delay(1000)
    }
    throw Error('acceptance_turn_timeout')
  }
  async function scenario(groupId, name, body, mentions, expected) {
    await guard()
    const message = await json(`/api/conversations/${groupId}/messages`, { body, mentions })
    check(typeof message?.id === 'string', 'acceptance_message_missing')
    const evidence = { name, messageId: message.id, status: 'running' }
    report.cases.push(evidence)
    const { turn, page, quality } = await readTurn(groupId, message.id)
    const trace = turn.trace, count = type => trace.events.filter(event => event.type === type).length
    const replies = page.messages.filter(item => item.replyToId === message.id && item.authorType !== 'user')
    Object.assign(evidence, { action: trace.action, responders: trace.responders, generations: count('generate'), publications: count('publish'), decision: trace.execution,
      decisionCostUsd: turn.decisionCostUsd, decisionLatencyMs: trace.decisionLatencyMs })
    check(expected.actions.includes(trace.action), 'acceptance_action_mismatch')
    assert.deepEqual(trace.responders, expected.responders, 'acceptance_responder_mismatch')
    check(count('generate') === expected.generations && count('publish') === expected.publications && replies.length === expected.publications, 'acceptance_side_effect_mismatch')
    if (!mentions.length) check(Boolean(trace.execution?.executionId && trace.execution?.providerGenerationId && trace.execution?.requestDigest), 'acceptance_decision_receipt_missing')
    check(quality.feedbackIsGroundTruth === false && trace.policyVersion === 'group-contribution-v1', 'acceptance_trace_contract')
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
      const choices = (menu?.groups ?? []).filter(group => group.kind === 'apiKey').flatMap(group => group.options)
      const option = choices.find(item => { try { assertFlashTestModel(item.modelId); return item.provider === 'deepseek' } catch { return false } })
      check(Boolean(option), 'acceptance_flash_model_unavailable')
      assertFlashTestModel(option.modelId)
      const selected = await json('/api/mobile/model', { bot: bot.id, id: option.id }, 'PUT')
      check(selected?.current?.modelId === option.modelId && selected.current.available === true, 'acceptance_model_not_selected')
      fixture.modelId = option.modelId
    }
    const group = await json('/api/conversations', { workspaceId, title: `Proactive acceptance ${report.fixtureId.slice(0,8)}`, members: report.bots.map(bot => ({ memberType: 'bot', memberId: bot.id })) })
    report.conversationId = group.id
    const [ui, , testing] = report.bots
    await scenario(group.id, 'useful-silence', '今天午饭不错。这只是闲聊，不需要回复，也不需要执行任何任务。', [], { actions: ['ignore','observe'], responders: [], generations: 0, publications: 0 })
    const help = await scenario(group.id, 'duty-matched-primary', '请负责UI设计的同事回答：保存按钮在请求进行中应该有什么反馈？只需一句交互建议，不要执行任务。', [], { actions: ['reply'], responders: [ui.id], generations: 1, publications: 1 })
    await scenario(group.id, 'explicit-mention', '请用一句话建议如何测试空值输入。只回答建议，不执行任务。', [{ memberType: 'bot', memberId: testing.id }], { actions: ['reply'], responders: [testing.id], generations: 1, publications: 1 })
    const feedback = await json(`/api/conversations/${group.id}/decisions`, { messageId: help, kind: 'helpful', targetId: ui.id })
    check(feedback.recorded === true && feedback.source === 'human_explicit' && feedback.policyChanged === false, 'acceptance_feedback_not_persisted')
    const forgery = await request(`/api/conversations/${group.id}/decisions`, { messageId: help, kind: 'helpful', source: 'agent_evaluation' })
    check(forgery.response.status === 422, 'acceptance_feedback_source_forgeable')
    await runGroupFactoryScenario({ report, json, readTurn, guard, download, timeoutMs: taskTimeoutMs, stopTimeoutMs })
    await version()
    report.status = 'pass'
    return report
  } catch (error) {
    report.status = 'fail'
    for (const item of report.cases) if (item.status === 'running') item.status = 'fail'
    report.error = error instanceof Error && /^acceptance_[a-z0-9_]+$/.test(error.message) ? error.message : 'acceptance_assertion_failed'
    return report
  } finally {
    report.finishedAt = new Date().toISOString()
    // Keep the synthetic history and receipts for review. Only this transient
    // login session is ended; unrelated account sessions are untouched.
    if (cookie) await request('/api/auth/sign-out', {}, 'POST').catch(() => {})
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
