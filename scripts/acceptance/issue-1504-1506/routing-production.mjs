// Issue #1504: three real production dispatches through the normal owner APIs.
// This only verifies dispatch/frozen routing. Server score/confidence logs and
// completed task quality are separate evidence; neither is invented here.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { decode, productionSession } from './production-session.mjs'

export const ACCEPTANCE_SHA = '2cba2a841ab770692559f1e5e18a0a57cff99952'
const WORKSPACE_REF = 'e917cd887945'
const AUTHORIZED_CONNECTIONS = new Set([
  'd1751637b97e74c21b09cef6f72c390dc87a142c910940464430c3c71e5363ca',
  '04903b6d2ad4d60a579485ef3e0a705a5a7283cf41414f6a044dbd2074f7e37c',
])
const AUTHORIZED_OWNER = '0cbf61fc889eb83126c705bd2a0e8c060eb2877e6acdd494db46244d313d86fe'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sha = value => /^[0-9a-f]{40}$/.test(value ?? '') ? value : null
const reference = value => typeof value === 'string' ? sha256(value).slice(0, 12) : null
const fixed = (value, values) => values.includes(value) ? value : 'unknown'
const KNOWN_MODELS = {
  'claude-haiku-5-5': 'light', 'gpt-6-luna': 'light', 'gpt-5.6-luna': 'light',
  'claude-sonnet-5-5': 'standard', 'gpt-6-sol': 'standard', 'gpt-5.6-sol': 'standard', 'gpt-5.6-terra': 'standard', 'gpt-5.5': 'standard',
  'claude-opus-5-5': 'strongest', 'claude-fable-5-1': 'strongest', 'gpt-6.1-sol': 'strongest', 'gpt-6-astra': 'strongest',
}
const RUN_STATES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing', 'completed', 'succeeded', 'failed', 'stopped', 'cancelled']
const REASONS = ['difficulty_fit', 'list_order', 'low_confidence', 'decision_unavailable', 'invalid_answer', 'no_selection', 'escalated']
const ERROR_CODES = new Set([
  'acceptance_sha_required', 'acceptance_version_mismatch', 'acceptance_version_changed', 'acceptance_deadline_exceeded',
  'acceptance_http_failed', 'acceptance_rpc_failed', 'acceptance_identity_mismatch', 'smoke_credentials_missing',
  'workspace_not_found', 'workspace_switch_failed', 'candidate_source_not_authorized', 'routing_unavailable', 'order_changed',
  'receipt_invalid', 'fixture_already_exists', 'fixture_ambiguous', 'fixture_scope_mismatch', 'fixture_not_found',
  'dispatch_not_new', 'dispatch_result_invalid', 'dispatch_outcome_unknown', 'routing_evidence_mismatch', 'routing_identity_mismatch',
  'runChainEnded', 'issueOutdated', 'issueNotFound', 'issueDeleteFailed', 'factoryStale', 'factoryStopped',
  'factoryNotFound', 'factoryInvalid', 'factoryUnavailable', 'factoryTransitionUnavailable', 'authRequired',
  'cleanup_incomplete', 'cleanup_scope_mismatch', 'cleanup_machine_pending', 'resume_requires_receipt',
])
const fail = code => { throw new Error(code) }
const safeError = error => ({ error: ERROR_CODES.has(error?.message) ? error.message : 'acceptance_failed',
  ...(ERROR_CODES.has(error?.details?.code) ? { code: error.details.code } : {}),
  ...(Number.isInteger(error?.details?.status) && error.details.status >= 100 && error.details.status <= 599 ? { httpStatus: error.details.status } : {}) })
const publicRequest = ({ path, method, status, headersMs, requestId }) => ({ path, method, status, headersMs,
  requestId: typeof requestId === 'string' && /^[a-z0-9:._-]{1,160}$/i.test(requestId) ? requestId : null })

export const CASES = [
  { key: 'text-normalization', harness: 'claude_code', tier: 'light', paragraphs: [
    '在本任务的临时目录创建一个 JavaScript 模块，导出 normalizeName(value)。它接收字符串，去掉首尾空白，并把内部连续空白折叠成一个普通空格。空字符串返回空字符串。给出三个 node:assert 例子并运行。交付模块与简短结果。',
  ] },
  { key: 'event-rollup', harness: 'codex', tier: 'standard', paragraphs: [
    '实现一个事件聚合模块。输入记录有 eventId、timestamp、category、amount。按 eventId 去重并保留 timestamp 最新的一条；按 UTC 日期及 category 汇总数量与 amount，输出稳定排序的结果。无效日期、非有限 amount 或缺少字段的记录进入 rejected，并说明原因。',
    '交付 JavaScript 模块和 node:test 测试，覆盖乱序输入、重复事件、跨 UTC 日期及非法记录。用合成数据运行测试，并简述边界处理。',
  ] },
  { key: 'leased-job-queue', harness: 'claude_code', tier: 'strongest', paragraphs: [
    '实现一个小型多租户作业队列，拆分为存储、调度器和测试模块。同一 tenantId 与 idempotencyKey 的提交去重，不同租户互相隔离；多个 worker 并发 claim 时只能有一个获胜。',
    '租约过期后允许接管，旧 worker 的 fencing token 不得完成新租约的任务。cancel 与 claim、complete 的竞争需要线性化；取消后不得自动重启。明确状态转移和不变量。',
    '使用内存存储、注入的时钟及显式调度，写确定性测试覆盖租约接管、迟到 worker、取消竞态、跨租户同 key 和并发 claim。解释关键竞态为什么安全，运行全部测试。仅使用 Node.js 标准库。',
  ] },
]
const botName = runKey => `Acceptance 1504 ${runKey}`
const issueTitle = (runKey, key) => `[acceptance-1504:${runKey}] ${key}`
const documentFor = item => ({ type: 'doc', content: [...item.paragraphs,
  '约束：只在本任务独立的临时目录中完成；不修改产品仓库、不发布、不联系他人、不调用外部服务或再创建其他任务。',
].map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) })
const routingView = routing => routing ? {
  version: routing.version === 2 ? 2 : routing.version === 1 ? 1 : null,
  required: fixed(routing.required, ['light', 'standard', 'strongest']),
  tier: fixed(routing.tier, ['light', 'standard', 'strongest']),
  harness: fixed(routing.harness, ['claude_code', 'codex']),
  model: Object.hasOwn(KNOWN_MODELS, routing.model) ? routing.model : 'unknown',
  effort: routing.effort == null ? null : fixed(routing.effort, ['low', 'medium', 'high', 'xhigh', 'max']),
  reason: fixed(routing.reason, REASONS),
} : null

function readReceipt(path) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { fail('receipt_invalid') }
  if (value?.schemaVersion !== 1 || value.issue !== 1504 || value.applicationSha !== ACCEPTANCE_SHA ||
    value.workspaceRef !== WORKSPACE_REF || !/^[a-zA-Z0-9_-]{1,36}$/.test(value.runKey ?? '') ||
    !Array.isArray(value.cases) || value.cases.length !== CASES.length || (value.botId && !UUID.test(value.botId))) fail('receipt_invalid')
  const cases = CASES.map(item => {
    const row = value.cases.find(row => row.key === item.key)
    if (!row || (row.issueId && !UUID.test(row.issueId)) || (row.runId && !UUID.test(row.runId)) ||
      !Array.isArray(row.runIds) || row.runIds.some(id => !UUID.test(id))) fail('receipt_invalid')
    return { key: item.key, expectedHarness: item.harness, expectedTier: item.tier,
      issueId: row.issueId ?? null, runId: row.runId ?? null, runIds: [...new Set(row.runIds)],
      createAttempted: row.createAttempted === true, dispatchAttempted: row.dispatchAttempted === true,
      status: 'pending', ...(row.deleted === true ? { deleted: true } : {}) }
  })
  return { runKey: value.runKey, botId: value.botId ?? null, botCreateAttempted: value.botCreateAttempted === true,
    ownerRef: /^[0-9a-f]{12}$/.test(value.ownerRef ?? '') ? value.ownerRef : null, cases }
}

export async function runRoutingAcceptance({ mode = 'dispatch', receiptPath = null, checkpoint = true, sessionFactory = productionSession } = {}) {
  const began = Date.now(), deadlineAt = began + 595_000, dispatchDeadline = began + 420_000
  const previous = mode === 'dispatch' ? null : receiptPath ? readReceipt(receiptPath) : fail('resume_requires_receipt')
  const runKey = previous?.runKey ?? process.env.MIKKA_ACCEPTANCE_RUN_KEY ?? (process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : null)
  if (!['dispatch', 'resume', 'cleanup'].includes(mode) || !/^[a-zA-Z0-9_-]{1,36}$/.test(runKey ?? '')) fail('receipt_invalid')
  // Cleanup deliberately remains possible after a later deployment.
  if (mode !== 'cleanup' && process.env.MIKKA_ACCEPTANCE_SHA !== ACCEPTANCE_SHA) fail('acceptance_sha_required')
  const retain = mode !== 'cleanup' && process.env.MIKKA_ROUTING_RETAIN_FIXTURES === '1'
  const report = { schemaVersion: 1, issue: 1504, phase: 'routing-production', mode, status: 'failed',
    applicationSha: ACCEPTANCE_SHA, driverSha: sha(process.env.GITHUB_SHA), runKey, workspaceRef: WORKSPACE_REF,
    startedAt: new Date(began).toISOString(), botId: previous?.botId ?? null,
    botCreateAttempted: previous?.botCreateAttempted ?? false, ownerRef: previous?.ownerRef ?? null,
    explicitModel: false, globalOrderWrites: 0, sourceGrantWrites: 0, retainedFixtures: retain,
    routingLogEvidence: 'pending_server_logs', taskCompletionEvidence: 'not_observed',
    cases: previous?.cases ?? CASES.map(item => ({ key: item.key, expectedHarness: item.harness, expectedTier: item.tier,
      issueId: null, runId: null, runIds: [], createAttempted: false, dispatchAttempted: false, status: 'pending' })),
    operations: [], requests: [], cleanup: { status: 'not_started', cases: [] } }
  const output = `issue-1504-1506-report/routing-production${mode === 'cleanup' ? '-cleanup' : ''}.json`
  let requests = [], context = null, baseline = null
  const save = () => {
    report.requests = requests.map(publicRequest)
    if (!checkpoint) return
    mkdirSync('issue-1504-1506-report', { recursive: true })
    writeFileSync(output + '.tmp', JSON.stringify(report, null, 2) + '\n')
    renameSync(output + '.tmp', output)
  }
  const op = async (name, action) => {
    const start = Date.now(), row = { name, startedAt: new Date(start).toISOString() }
    report.operations.push(row)
    try { const value = await action(); row.status = 'ok'; return value }
    catch (error) { Object.assign(row, { status: 'failed' }, safeError(error)); throw error }
    finally { row.durationMs = Date.now() - start; save() }
  }
  try {
    await sessionFactory(async session => {
      requests = session.requests
      const { identity } = session
      if (report.ownerRef && report.ownerRef !== reference(identity.userId)) fail('acceptance_identity_mismatch')
      report.ownerRef = reference(identity.userId)
      report.observedApplicationSha = sha(session.version.build)
      const api = async (path, body, method, limit = 25_000) => {
        const response = await session.request(path, { body, method, signal: AbortSignal.timeout(limit) })
        const value = await response.json().catch(() => null)
        if (!response.ok || value?.error) {
          const error = new Error('acceptance_http_failed')
          error.details = { status: response.status, code: typeof value?.error === 'string' ? value.error : value?.error?.code }
          throw error
        }
        return value
      }
      const rpc = async (action, args = []) => {
        const response = await session.request('/api/rpc', { body: { version: 1, action, args },
          headers: { 'x-mikka-rpc': '1' }, signal: AbortSignal.timeout(25_000) })
        const envelope = await response.json().catch(() => null), value = decode(envelope?.result)
        if (!response.ok || !envelope?.ok || value?.error) {
          const error = new Error('acceptance_rpc_failed')
          error.details = { status: response.status, code: envelope?.error?.code ?? value?.error }
          throw error
        }
        return value
      }
      const switcher = await op('workspace.discover', () => api('/api/workspace/switcher'))
      const account = switcher.accounts?.find(row => row.id === identity.userId)
      const choices = account?.choices?.filter(row => UUID.test(row.id ?? '') && reference(row.id) === WORKSPACE_REF) ?? []
      if (choices.length !== 1 || choices[0].kind !== 'team') fail('workspace_not_found')
      const workspaceId = choices[0].id
      await op('workspace.switch_session', () => rpc('workspace.switchWorkspace', [workspaceId]))
      const switched = await op('workspace.verify_session', () => api('/api/workspace/switcher'))
      if (switched.workspace?.id !== workspaceId || !switched.accounts?.some(row => row.id === identity.userId)) fail('workspace_switch_failed')
      context = { api, rpc, identity, workspaceId }
      const verifyOrder = async () => {
        if ((await api('/api/version')).build !== ACCEPTANCE_SHA) fail('acceptance_version_changed')
        const order = await rpc('model-order.getModelOrder', [workspaceId])
        // Diagnose the current product view before any fixture exists, without credentials or source IDs.
        report.orderObservation = { autoModelRouting: order?.autoModelRouting === true, cloudReady: order?.cloudReady === true,
          candidates: Array.isArray(order?.candidates) ? order.candidates.length : null,
          entries: Array.isArray(order?.entries) ? order.entries.map(entry => ({
            harness: fixed(entry.harness, ['claude_code', 'codex']),
            model: Object.hasOwn(KNOWN_MODELS, entry.model) ? entry.model : 'unknown',
            block: entry.block ? fixed(entry.block.reason, ['checking', 'quota', 'expired', 'paused', 'missing', 'removed', 'modelGone', 'keyRefused', 'balance', 'providerUnavailable', 'noDevice']) : null,
            cloudModel: fixed(order.cloudModels?.[entry.id], ['ready', 'cloudModelsUnknown', 'cloudModelNotReported']),
          })) : null }; save()
        if (order.autoModelRouting !== true || order.cloudReady !== true || !Array.isArray(order.candidates) || !order.candidates.length || !Array.isArray(order.entries)) fail('routing_unavailable')
        for (const entry of [...order.candidates, ...order.entries]) {
          if (entry.source?.kind !== 'subscription' || typeof entry.source.connectionId !== 'string' ||
            !AUTHORIZED_CONNECTIONS.has(sha256(entry.source.connectionId))) fail('candidate_source_not_authorized')
        }
        // The settings view marks quota older than 15 minutes as checking without probing it.
        // Ordinary dispatch admission refreshes that state and still enforces the actual quota.
        const available = order.entries.filter(entry => !entry.block || entry.block.reason === 'checking')
        if (!CASES.every(item => available.some(entry => entry.harness === item.harness && KNOWN_MODELS[entry.model] === item.tier))) fail('routing_unavailable')
        const fingerprint = sha256(JSON.stringify({ location: order.location, customized: order.customized,
          preferredHarness: order.preferredHarness, autoModelRouting: order.autoModelRouting,
          entries: order.entries.map(({ harness, model, source }) => ({ harness, model, source })) }))
        if (baseline && baseline !== fingerprint) fail('order_changed')
        baseline = fingerprint
        report.configuration = { autoRouting: true, cloudReady: true, authorizedSourcesOnly: true,
          candidateCount: order.candidates.length, entryCount: order.entries.length, orderFingerprint: fingerprint }
      }
      const verifyBot = bot => {
        if (!bot || !UUID.test(bot.id ?? '') || bot.ownerId !== identity.userId || bot.workspaceId !== workspaceId || bot.name !== botName(runKey)) fail('fixture_scope_mismatch')
        if (report.botId && report.botId !== bot.id) fail('fixture_scope_mismatch')
        report.botId = bot.id; context.botVerified = true; save(); return bot
      }
      const verifyIssue = (issue, item, row) => {
        if (!issue || !UUID.test(issue.id ?? '') || issue.userId !== identity.userId || issue.title !== issueTitle(runKey, item.key) ||
          (row.issueId && issue.id !== row.issueId) || issue.linearTargetVerified === true) fail('fixture_scope_mismatch')
        row.issueId = issue.id; save(); return issue
      }
      const discoverIssue = async (item, row) => {
        const all = await rpc('issues.listIssues')
        const matches = (Array.isArray(all) ? all : []).filter(issue => issue.ownerId === identity.userId && issue.title === issueTitle(runKey, item.key))
        if (matches.length !== 1) fail(matches.length ? 'fixture_ambiguous' : 'fixture_not_found')
        return verifyIssue((await rpc('issues.getIssue', [matches[0].id])).issue, item, row)
      }
      const collectRunsOnce = async row => {
        const data = await rpc('agents.pollIssueThreads', [row.issueId])
        for (const thread of data.threads ?? []) if (thread.ownedByCurrentUser === true) {
          for (const id of [thread.rootRunId, thread.latestRunId, ...(thread.attempts ?? []).map(attempt => attempt.runId)]) if (UUID.test(id ?? '')) row.runIds.push(id)
        }
        row.runIds = [...new Set(row.runIds)]; save()
      }
      const readFrozen = async (item, row) => {
        const evidence = await op(`${item.key}.frozen_evidence`, () => api(`/api/runs/${row.runId}/evidence`))
        const run = evidence?.run, identity = run?.executionIdentity
        if (run?.id !== row.runId || run.issueId !== row.issueId || run.botId !== report.botId) fail('routing_identity_mismatch')
        row.frozenRouting = routingView(run.modelRouting)
        row.observedStatus = fixed(run.status, RUN_STATES)
        row.observedModel = Object.hasOwn(KNOWN_MODELS, run.model) ? run.model : 'unknown'
        const binding = identity?.resourceBindings?.find(binding => binding.kind === 'subscription')
        row.executionIdentityVerified = identity?.requester === context.identity.userId && identity?.botOwner === context.identity.userId &&
          identity?.executionPrincipal === context.identity.userId && identity?.outputOwner === context.identity.userId &&
          identity?.botId === report.botId && identity?.workspaceId === workspaceId &&
          identity?.billingAccount?.model?.kind === 'subscription' &&
          typeof identity?.billingAccount?.model?.ownerId === 'string' && sha256(identity.billingAccount.model.ownerId) === AUTHORIZED_OWNER &&
          binding?.access === 'workspace_share' && typeof binding?.ownerId === 'string' && sha256(binding.ownerId) === AUTHORIZED_OWNER
        row.credentialType = fixed(run.credentialType, ['subscription', 'api_key', 'unknown'])
        row.sourceConnectionEvidence = 'candidate_allowlist_and_frozen_owner;exact_binding_join_pending'
        save()
        if (!row.executionIdentityVerified || run.credentialType !== 'subscription') fail('routing_identity_mismatch')
        const route = row.frozenRouting
        if (!route || route.version !== 2 || route.required !== item.tier || route.tier !== item.tier || route.harness !== item.harness ||
          route.reason !== 'difficulty_fit' || run.harness !== item.harness || run.model !== route.model || KNOWN_MODELS[route.model] !== item.tier) fail('routing_evidence_mismatch')
        row.status = 'frozen_evidence_passed'; save()
      }
      context.verifyBot = verifyBot; context.verifyIssue = verifyIssue; context.discoverIssue = discoverIssue; context.collectRunsOnce = collectRunsOnce
      try {
        if (mode !== 'cleanup') {
          await op('fixture.share_existing_smoke_credits', async () => {
            const before = await rpc('personal-policy.getCreditShare', [workspaceId])
            if (before.canShare !== true || before.admin !== true || typeof before.mine !== 'boolean') fail('fixture_scope_mismatch')
            report.smokeCreditShare = { previous: before.mine, enabled: false }
            if (!before.mine) await rpc('personal-policy.updateCreditShare', [true, workspaceId])
            const after = await rpc('personal-policy.getCreditShare', [workspaceId])
            if (after.mine !== true || after.canShare !== true) fail('routing_unavailable')
            report.smokeCreditShare.enabled = true
          })
          await op('routing.preflight', verifyOrder)
        }
        const bots = await op('bot.discover', () => api('/api/bots'))
        if (!Array.isArray(bots)) fail('fixture_scope_mismatch')
        const matching = bots.filter(bot => bot.name === botName(runKey))
        if (matching.length > 1) fail('fixture_ambiguous')
        if (mode === 'dispatch' && matching.length) fail('fixture_already_exists')
        if (matching.length) verifyBot(matching[0])
        else if (mode === 'cleanup' && !report.botCreateAttempted) return
        else if (report.botId || report.botCreateAttempted) fail('fixture_not_found')
        else {
          if (Date.now() >= dispatchDeadline) fail('acceptance_deadline_exceeded')
          report.botCreateAttempted = true; save()
          try { verifyBot(await op('bot.create', () => api('/api/bots', { name: botName(runKey) }))) }
          catch (error) {
            // Recover an acknowledged-at-server creation once; never repeat POST.
            const recovered = (await api('/api/bots')).filter(bot => bot.name === botName(runKey))
            if (recovered.length === 1) verifyBot(recovered[0])
            throw error
          }
        }
        context.botVerified = true
        if (mode === 'cleanup') return
        for (const item of CASES) {
          const row = report.cases.find(row => row.key === item.key)
          try {
            if (row.deleted) { row.status = 'already_cleaned'; continue }
            if (Date.now() >= dispatchDeadline) fail('acceptance_deadline_exceeded')
            await op(`${item.key}.configuration_check`, verifyOrder)
            let issue
            if (row.issueId) issue = verifyIssue((await rpc('issues.getIssue', [row.issueId])).issue, item, row)
            else if (row.createAttempted) issue = await discoverIssue(item, row)
            else {
              row.createAttempted = true; save()
              try { issue = verifyIssue((await op(`${item.key}.create`, () => rpc('issues.saveIssue', [{
                title: issueTitle(runKey, item.key), content: documentFor(item), status: 'todo', priority: 'low',
              }]))).issue, item, row) }
              catch (error) { await discoverIssue(item, row).catch(() => {}); throw error }
            }
            // Explicitly personal: these synthetic fixtures must not be published to a team tracker.
            if (!row.dispatchAttempted) {
              issue = verifyIssue((await op(`${item.key}.scope`, () => rpc('issues.setIssueScope', [{ id: issue.id, revision: issue.revision, scope: 'personal' }]))).issue, item, row)
              if (issue.scope !== 'personal') fail('fixture_scope_mismatch')
              row.dispatchAttempted = true; row.dispatchStartedAt = new Date().toISOString(); save()
              const started = Date.now()
              const value = await op(`${item.key}.dispatch`, () => api(`/api/bots/${report.botId}/computer/runs`, {
                issueId: issue.id, harness: item.harness, profileId: 'default', needsSpec: false,
              }, 'POST', Math.min(120_000, Math.max(1, dispatchDeadline - Date.now()))))
              row.dispatchDurationMs = Date.now() - started
              row.dispatchFinishedAt = new Date().toISOString()
              if (!UUID.test(value?.runId ?? '')) fail('dispatch_result_invalid')
              row.runId = value.runId; row.runIds = [...new Set([...row.runIds, value.runId])]; save()
              if (value.thread !== 'new') fail('dispatch_not_new')
            } else if (!row.runId) {
              // Resume uncertain outcomes by discovery only, never by another dispatch.
              await op(`${item.key}.recover_run_once`, () => collectRunsOnce(row))
              if (row.runIds.length !== 1) fail('dispatch_outcome_unknown')
              row.runId = row.runIds[0]; save()
            }
            await readFrozen(item, row)
          } catch (error) { Object.assign(row, { status: 'failed' }, safeError(error)); save() }
        }
        await op('routing.final_configuration_check', verifyOrder)
        report.configurationUnchanged = true
      } finally {
        await cleanup(context, report, { retain, op, save })
      }
    }, { deadlineAt, expectedSha: mode === 'cleanup' ? null : ACCEPTANCE_SHA })
    report.signedOut = requests.some(request => request.path === '/mikka/api/auth/sign-out' && request.status >= 200 && request.status < 300)
    if (mode === 'cleanup') report.status = report.cleanup.status === 'complete' && report.signedOut ? 'cleanup_passed' : 'failed'
    else report.status = report.cases.every(row => row.status === 'frozen_evidence_passed') && report.configurationUnchanged &&
      report.cleanup.status === 'complete' && report.signedOut ? 'dispatch_evidence_passed' : 'failed'
  } catch (error) { Object.assign(report, safeError(error)) }
  report.signedOut = requests.some(request => request.path === '/mikka/api/auth/sign-out' && request.status >= 200 && request.status < 300)
  report.finishedAt = new Date().toISOString(); report.durationMs = Date.now() - began
  save(); return report
}

async function cleanup(context, report, { retain, op, save }) {
  report.cleanup = { status: 'running', cases: [], botHidden: false }; save()
  if (!context?.botVerified) {
    report.cleanup.status = report.botCreateAttempted ? 'needs_followup' : 'complete'; save(); return
  }
  const { api, rpc, identity, verifyIssue, discoverIssue, collectRunsOnce } = context
  let failed = false
  for (const item of CASES) {
    const row = report.cases.find(row => row.key === item.key), result = { key: item.key, status: 'complete', runs: [], tasks: [] }
    report.cleanup.cases.push(result)
    try {
      if (!row.issueId && row.createAttempted) await op(`${item.key}.cleanup_discover_issue`, () => discoverIssue(item, row))
      if (!row.issueId) continue
      let issue
      try { issue = verifyIssue((await rpc('issues.getIssue', [row.issueId])).issue, item, row) }
      catch (error) {
        const deleted = await rpc('issue-operations.getDeletedIssue', [row.issueId])
        if (deleted?.id === row.issueId && deleted.title === issueTitle(report.runKey, item.key)) { row.deleted = true; result.alreadyDeleted = true }
        else throw error
      }
      if (!row.deleted) {
        // Freeze the Factory lifecycle before stopping machines, preventing new auto-review runs.
        try {
          const listed = await op(`${item.key}.cleanup_tasks`, () => api(`/api/factory/tasks?issueId=${row.issueId}`))
          for (const summary of listed.tasks ?? []) {
            if (!UUID.test(summary.id ?? '')) fail('cleanup_scope_mismatch')
            let detail = await api(`/api/factory/tasks/${summary.id}`)
            const verify = detail => {
              if (detail?.task?.id !== summary.id || detail.task.userId !== identity.userId || detail.task.botId !== report.botId || detail.task.issueId !== row.issueId) fail('cleanup_scope_mismatch')
              for (const attempt of detail.attempts ?? []) if (UUID.test(attempt.runId ?? '')) row.runIds.push(attempt.runId)
              row.runIds = [...new Set(row.runIds)]; save()
            }
            verify(detail)
            if (!['cancelled', 'revoked', 'published'].includes(detail.task.status)) {
              const cancel = () => api(`/api/factory/tasks/${summary.id}`, { binding: { taskId: summary.id, revision: detail.task.revision },
                eventId: randomUUID(), action: 'cancel', reason: 'Issue 1504 routing acceptance evidence captured; release owned test resources.' })
              try { detail = await op(`${item.key}.cleanup_cancel`, cancel) }
              catch (error) {
                if (error?.details?.code !== 'factoryStale') throw error
                // One optimistic-concurrency refresh; no polling or execution retry.
                detail = await api(`/api/factory/tasks/${summary.id}`); verify(detail)
                if (!['cancelled', 'revoked', 'published'].includes(detail.task.status)) detail = await op(`${item.key}.cleanup_cancel_after_revision`, cancel)
              }
              verify(detail)
            }
            result.tasks.push({ taskId: summary.id, status: fixed(detail.task.status, ['cancelled', 'revoked', 'published']) })
          }
        } catch (error) {
          result.factoryError = safeError(error); result.status = 'needs_followup'; failed = true
        }
        try { await op(`${item.key}.cleanup_threads_once`, () => collectRunsOnce(row)) }
        catch (error) { result.discoveryError = safeError(error); result.status = 'needs_followup'; failed = true }
      }
      if (row.dispatchAttempted && row.runIds.length === 0) {
        result.discoveryError = { error: 'dispatch_outcome_unknown' }; result.status = 'needs_followup'; failed = true
      }
      for (const runId of row.runIds) {
        const runResult = { runId, stopped: false, machineEnded: false }; result.runs.push(runResult)
        try {
          const run = (await api(`/api/runs/${runId}/evidence`))?.run
          if (run?.id !== runId || run.issueId !== row.issueId || run.botId !== report.botId) fail('cleanup_scope_mismatch')
          try { await op(`${item.key}.cleanup_stop`, () => rpc('agents.stopRun', [runId])); runResult.stopped = true }
          catch (error) { if (error?.details?.code === 'runChainEnded') runResult.stopped = true; else runResult.stopError = safeError(error) }
          const ended = await op(`${item.key}.cleanup_end_machine`, () => api(`/api/threads/${runId}/machine`, { action: 'end' }, 'POST', 45_000))
          if (ended?.runId !== runId || ended.state !== 'ended') fail('cleanup_machine_pending')
          runResult.machineEnded = true; runResult.stopped = true
        } catch (error) { Object.assign(runResult, safeError(error)); failed = true; result.status = 'needs_followup' }
      }
      if (!retain && !row.deleted && result.status === 'complete') {
        issue = verifyIssue((await rpc('issues.getIssue', [row.issueId])).issue, item, row)
        const remove = () => rpc('issue-operations.setIssueDeleted', [{ id: row.issueId, revision: issue.revision, restore: false }])
        try { await op(`${item.key}.cleanup_delete`, remove) }
        catch (error) {
          if (error?.details?.code !== 'issueOutdated') throw error
          issue = verifyIssue((await rpc('issues.getIssue', [row.issueId])).issue, item, row)
          await op(`${item.key}.cleanup_delete_after_revision`, remove)
        }
        const deleted = await rpc('issue-operations.getDeletedIssue', [row.issueId])
        if (deleted?.id !== row.issueId || deleted.title !== issueTitle(report.runKey, item.key)) fail('cleanup_incomplete')
        row.deleted = true; result.deleted = true
      }
    } catch (error) { Object.assign(result, { status: 'needs_followup' }, safeError(error)); failed = true }
    finally { save() }
  }
  if (!retain) {
    try {
      const hidden = await op('bot.cleanup_hide', () => api(`/api/mobile/bots/${report.botId}`, { hidden: true }, 'PATCH'))
      if (hidden?.ok !== true) fail('cleanup_incomplete')
      report.cleanup.botHidden = true
    }
    catch (error) { report.cleanup.botError = safeError(error); failed = true }
  }
  report.cleanup.status = failed ? 'needs_followup' : 'complete'; save()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runRoutingAcceptance({ mode: process.argv[2] ?? 'dispatch', receiptPath: process.argv[3] ?? null })
    console.log(JSON.stringify(report))
    if (!['dispatch_evidence_passed', 'cleanup_passed'].includes(report.status)) process.exitCode = 1
  } catch (error) { console.log(JSON.stringify({ issue: 1504, status: 'failed', ...safeError(error) })); process.exitCode = 1 }
}
