import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const FIXED = Object.freeze({
  origin: 'https://app.aspectlylabs.com',
  revision: '7b212367026f090907f724b618743ae63f7fa68a',
  deploymentId: 'dpl_6ECwt2WNzdho8NLMJMZvLCb2eZVw',
  failedCoreRevision: '8c94364458632edb2964e54f0a478bb70fedbbd5',
  failedCoreDeploymentId: 'dpl_EoqgaeT54ZVwBTLgstoR7JrGamgC',
  conversationId: '61da4558-76da-4d87-b02b-1bba6748bf34',
  messageId: '35f1590d-f8b0-4696-801b-6773734c7d2b',
  workspaceId: '0f877068-66a0-4893-8801-9a14eb3116b3',
  requesterId: 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3',
  botIds: Object.freeze(['1cf52051-c7a4-4777-8eac-b16e6cbae050', '0d65493b-0d2d-402c-8509-d0582a697082', 'd6304047-f1aa-49b6-b7ea-55a98a9c5ba0']),
})
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const TOKEN = /^[A-Za-z0-9_.:-]{1,180}$/
const DIGEST = /^[a-f0-9]{64}$/
const ACTIONS = new Set(['ignore', 'observe', 'reply', 'delegate', 'clarify'])
const STATUSES = new Set(['pending', 'queued', 'running', 'complete', 'failed', 'blocked', 'stopped'])
const ERRORS = new Set(['group_judgment_pending', 'group_lead_required', 'stopped', 'interrupted_generation_not_replayed',
  'generation_timeout', 'generation_aborted', 'generation_authentication', 'generation_rate_limited',
  'generation_upstream', 'generation_invalid_output', 'generation_failed_not_replayed'])
const EVENT_TYPES = ['wake', 'generate', 'silent', 'publish', 'private_publish', 'delegate', 'task_result']
const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const safeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
class StopError extends Error { constructor(code) { super('group_stop_' + code) } }
const check = (ok, code) => { if (!ok) throw new StopError(code) }
const safeError = error => error instanceof StopError ? error.message : 'group_stop_unconfirmed'
const memberKey = row => row.memberType + ':' + row.id
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Finite projections only. Raw provider answers are not stored by this API. */
export function projectDecisionPage(page) {
  check(Array.isArray(page?.turns) && page.turns.length <= 100 && page.feedbackIsGroundTruth === false, 'decision_page_shape')
  return {
    turnCount: page.turns.length, feedbackIsGroundTruth: false,
    costScope: page.costScope === 'primary-routing-decision-api' ? page.costScope : 'unknown',
    turns: page.turns.map(turn => {
      const trace = turn.trace, execution = trace?.execution, events = Array.isArray(trace?.events) ? trace.events : []
      const receipt = execution && TOKEN.test(execution.executionId ?? '') && TOKEN.test(execution.providerGenerationId ?? '')
        && execution.modelId === 'openai/gpt-6-luna-decisions' && DIGEST.test(execution.requestDigest ?? '')
        ? { executionId: execution.executionId, providerGenerationId: execution.providerGenerationId,
          modelId: execution.modelId, requestDigest: execution.requestDigest } : null
      const fields = ['schemaVersion', 'policyVersion', 'contextMessageIds', 'memberVersion', 'members', 'purpose',
        'action', 'reason', 'responders', 'execution', 'decisionLatencyMs', 'startedAt', 'finishedAt', 'taskFinishedAt', 'events', 'status']
      const shape = Object.fromEntries(fields.map(key => [key, type(trace?.[key])]))
      const eventCounts = Object.fromEntries(EVENT_TYPES.map(key => [key, events.filter(e => e?.type === key).length]))
      const responders = Array.isArray(trace?.responders) ? trace.responders : []
      return { messageId: UUID.test(turn.messageId ?? '') ? turn.messageId : null,
        status: STATUSES.has(turn.status) ? turn.status : 'unknown', errorType: type(turn.error),
        errorCode: turn.error == null ? null : ERRORS.has(turn.error) ? turn.error : 'unrecognized',
        decisionCostUsd: safeNumber(turn.decisionCostUsd), feedbackCount: Array.isArray(turn.feedback) ? turn.feedback.length : null,
        trace: { type: type(trace), fields: shape, unknownFieldCount: trace && typeof trace === 'object' && !Array.isArray(trace)
          ? Object.keys(trace).filter(k => !fields.includes(k)).length : null,
          schemaVersion: safeNumber(trace?.schemaVersion),
          policyVersion: trace?.policyVersion === 'group-contribution-v1' ? trace.policyVersion : null,
          status: STATUSES.has(trace?.status) ? trace.status : 'unknown', action: ACTIONS.has(trace?.action) ? trace.action : null,
          responderIds: responders.filter(id => FIXED.botIds.includes(id)), unknownResponderCount: responders.filter(id => !FIXED.botIds.includes(id)).length,
          memberCount: Array.isArray(trace?.members) ? trace.members.length : null,
          contextMessageCount: Array.isArray(trace?.contextMessageIds) ? trace.contextMessageIds.length : null,
          eventCount: events.length, eventCounts, unknownEventCount: events.filter(e => !EVENT_TYPES.includes(e?.type)).length,
          executionType: type(execution), receipt, decisionLatencyMs: safeNumber(trace?.decisionLatencyMs) } }
    }),
  }
}

export async function runFailedGroupStop({ env = process.env, fetchImpl = fetch, repo = process.cwd(), accountValidator,
  verifySource = () => {
    check(!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim(), 'source_dirty')
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  } } = {}) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && env.GITHUB_REF === 'refs/heads/acceptance/proactive-1157-1163' && env.GITHUB_EVENT_NAME === 'push', 'workflow_scope')
  check(env.GROUP_STOP_REVISION === FIXED.revision && env.GROUP_STOP_DEPLOYMENT === FIXED.deploymentId
    && (!env.GROUP_STOP_ORIGIN || env.GROUP_STOP_ORIGIN === FIXED.origin), 'fixed_target_required')
  check(verifySource() === FIXED.revision, 'source_revision_mismatch')
  const isSmoke = accountValidator ?? (await import(pathToFileURL(resolve(repo, 'lib/smoke-account.ts')).href)).isSmokeAccountEmail
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  check(isSmoke(email) && typeof password === 'string' && password.length > 0, 'normal_smoke_credentials_required')
  const start = Date.now(), end = start + 180_000
  const base = '/api/conversations/' + FIXED.conversationId
  const paths = new Map([
    ['/api/version', 'GET'], ['/api/auth/sign-in/email', 'POST'], ['/api/auth/get-session', 'GET'],
    ['/api/bots', 'GET'], ['/api/conversations?workspaceId=' + FIXED.workspaceId, 'GET'], [base + '/members', 'GET'],
    [base + '/decisions?limit=100', 'GET'], [base + '/stop', 'POST'], ['/api/auth/sign-out', 'POST'],
  ])
  const report = { schemaVersion: 1, status: 'failed', scope: 'stop-one-known-failed-core-group',
    revision: FIXED.revision, deploymentId: FIXED.deploymentId, conversationId: FIXED.conversationId, messageId: FIXED.messageId,
    failedCore: { workflowRunId: '41762211922', revision: FIXED.failedCoreRevision, deploymentId: FIXED.failedCoreDeploymentId },
    workspaceId: FIXED.workspaceId, requesterId: FIXED.requesterId, botIds: [...FIXED.botIds],
    versions: [], before: null, after: null, errors: [], http: { login: null, stop: null, logout: null },
    checks: { normalOwnerSession: false, exactFixtureMetadata: false, exactMembers: false, onlyExpectedTurn: false },
    stop: { attempted: false, acknowledged: false, reportedStoppedTurns: null, recorded: false, noPendingRetry: false, executionStopConfirmed: false },
    cleanup: { logoutAttempted: false, logoutAcknowledged: false }, counts: { get: 0, post: 0 },
    limitations: { rawProviderAnswersAvailable: false, absentReceiptDoesNotProveNoInvocation: true,
      settledCostMayBeUnavailable: true, executionStopNotIndependentlyConfirmed: true },
    generationRequestsSent: 0, replayRequestsSent: 0, messageHistoryRequestsSent: 0, providerCredentialsRead: false }
  let cookie = ''
  async function request(path, method = 'GET', body, cleanup = false) {
    check(paths.get(path) === method, 'path_forbidden')
    if (method === 'GET') check(++report.counts.get <= 10, 'read_budget')
    else { report.counts.post++; check(report.counts.post <= 3, 'write_budget') }
    const remaining = cleanup ? 15_000 : Math.min(15_000, end - Date.now())
    check(remaining > 0, 'time_budget')
    const response = await fetchImpl(FIXED.origin + '/mikka' + path, { method, redirect: 'error', signal: AbortSignal.timeout(remaining),
      headers: { origin: FIXED.origin, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (path === '/api/auth/sign-in/email') {
      report.http.login = response.status
      cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    }
    const text = await response.text()
    check(Buffer.byteLength(text) <= 1024 * 1024, 'body_limit')
    let data
    try { data = JSON.parse(text) } catch { throw new StopError('response_shape') }
    return { response, data }
  }
  async function get(path, cleanup = false) { const r = await request(path, 'GET', undefined, cleanup); check(r.response.status === 200, 'read_failed'); return r.data }
  async function version(phase, cleanup = false) {
    const data = await get('/api/version', cleanup), matched = data?.build === FIXED.deploymentId
    report.versions.push({ phase, matched, build: matched ? FIXED.deploymentId : null })
    check(matched, 'deployment_changed')
  }
  function expectedTurn(page) {
    check(Array.isArray(page?.turns) && page.turns.length === 1 && page.turns[0].messageId === FIXED.messageId, 'unexpected_group_turn')
    return page.turns[0]
  }
  try {
    await version('before')
    const login = await request('/api/auth/sign-in/email', 'POST', { email, password })
    report.http.login = login.response.status
    check(login.response.status === 200, 'login_failed')
    cookie = login.response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    check(Boolean(cookie), 'session_missing')
    const session = await get('/api/auth/get-session')
    check(session?.user?.id === FIXED.requesterId && session.user.email?.toLowerCase() === email.toLowerCase(), 'owner_identity_mismatch')
    report.checks.normalOwnerSession = true
    const groups = await get('/api/conversations?workspaceId=' + FIXED.workspaceId)
    const group = groups?.conversations?.find(g => g.id === FIXED.conversationId)
    check(group?.createdBy === FIXED.requesterId && group.workspaceId === FIXED.workspaceId && group.kind === 'group'
      && /^Proactive acceptance [a-f0-9]{8}$/.test(group.title ?? '') && Number.isFinite(Date.parse(group.createdAt)), 'group_fixture_mismatch')
    const marker = group.title.slice(-8)
    const bots = await get('/api/bots')
    check(Array.isArray(bots), 'bots_shape')
    const selected = FIXED.botIds.map(id => bots.find(b => b.id === id))
    check(selected.every(b => b?.ownerId === FIXED.requesterId && b.workspaceId === FIXED.workspaceId)
      && same(selected.map(b => b.name).sort(), ['UI', 'Coding', 'Testing'].map(role => 'Acceptance ' + role + ' ' + marker).sort()), 'bot_fixture_mismatch')
    report.checks.exactFixtureMetadata = true
    const members = (await get(base + '/members'))?.members
    check(Array.isArray(members) && same(members.map(memberKey).sort(), ['user:' + FIXED.requesterId, ...FIXED.botIds.map(id => 'bot:' + id)].sort())
      && members.find(m => m.memberType === 'user' && m.id === FIXED.requesterId)?.role === 'owner', 'membership_mismatch')
    report.checks.exactMembers = true
    const before = await get(base + '/decisions?limit=100')
    expectedTurn(before); report.before = projectDecisionPage(before); report.checks.onlyExpectedTurn = true
    await version('before-stop')
    report.stop.attempted = true
    try {
      const stopped = await request(base + '/stop', 'POST', {})
      report.http.stop = stopped.response.status
      report.stop.acknowledged = stopped.response.status === 200 && Number.isSafeInteger(stopped.data?.stopped) && stopped.data.stopped >= 0 && stopped.data.stopped <= 1
      report.stop.reportedStoppedTurns = report.stop.acknowledged ? stopped.data.stopped : null
    } catch (error) { report.errors.push(safeError(error)) }
    const after = await get(base + '/decisions?limit=100'), turn = expectedTurn(after)
    report.after = projectDecisionPage(after)
    report.stop.recorded = turn.status === 'failed' && turn.error === 'stopped' && turn.trace?.status === 'stopped'
    report.stop.noPendingRetry = ['complete', 'failed', 'stopped'].includes(turn.status)
      && !['queued', 'running'].includes(turn.trace?.status) && turn.error !== 'group_judgment_pending'
    report.requiresAdditionalTaskCleanup = report.after.turns.some(t => t.trace.eventCounts.delegate > 0)
    check(report.stop.acknowledged && report.stop.noPendingRetry, 'stop_not_confirmed')
  } catch (error) { report.errors.push(safeError(error)) }
  finally {
    if (cookie) {
      report.cleanup.logoutAttempted = true
      try { const logout = await request('/api/auth/sign-out', 'POST', {}, true)
        report.http.logout = logout.response.status; report.cleanup.logoutAcknowledged = logout.response.status === 200
      } catch { report.errors.push('group_stop_logout_unconfirmed') }
      cookie = ''
    }
    try { await version('after', true) } catch (error) { report.errors.push(safeError(error)) }
  }
  report.elapsedMs = Date.now() - start
  report.status = report.errors.length === 0 && Object.values(report.checks).every(Boolean)
    && report.stop.acknowledged && report.stop.noPendingRetry && report.cleanup.logoutAcknowledged
    && report.versions.length === 3 && report.versions.every(v => v.matched) ? 'passed' : 'failed'
  return report
}

export async function writeStopReport(path, report, knownSecrets = []) {
  const text = JSON.stringify(report, null, 2) + '\n'
  check(!knownSecrets.filter(s => typeof s === 'string' && s.length >= 3).some(s => text.includes(s)), 'output_secret_detected')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, { flag: 'wx', mode: 0o600 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result
  try { result = await runFailedGroupStop() } catch (error) { result = { schemaVersion: 1, status: 'failed', error: safeError(error) } }
  try {
    check(typeof process.env.GROUP_STOP_OUTPUT === 'string' && process.env.GROUP_STOP_OUTPUT.length > 0, 'output_required')
    await writeStopReport(resolve(process.env.GROUP_STOP_OUTPUT), result, [process.env.SMOKE_OWNER_EMAIL, process.env.SMOKE_OWNER_PASSWORD])
    process.stdout.write(JSON.stringify({ status: result.status, conversationId: FIXED.conversationId,
      stopRecorded: result.stop?.recorded ?? false, noPendingRetry: result.stop?.noPendingRetry ?? false, logout: result.cleanup?.logoutAcknowledged ?? false }) + '\n')
  } catch { process.stderr.write('group_stop_report_failed\n'); process.exitCode = 1 }
  if (result.status !== 'passed') process.exitCode = 1
}
