/** One ordinary, owned pre-migration publication fixture for #1782.
 * Use only if a fresh authorized collection still has no published history.
 * This is delivery preparation; independent GitHub verification and readonly
 * APP before capture remain required. It cannot merge or publish deployment. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { workflowGuard } from './self-hosted-closeout.mjs'
import { authorize } from './publication-preflight-1782.mjs'
import { readHistoryTaskAccess } from './domain-history-before-1782.mjs'
import { createSessionClient, decodeWire, smokeAcceptanceAccount, subscriptionProof, watchRun } from '../acceptance/cloud-startup.mjs'

export const REPOSITORY = 'alexj11324/Mikka-handoff'
export const FIXTURE_PATH = 'docs/issue-1782/pre-migration-history-check.md'
export const FIXTURE_SHA256 = '8f20e0fbf354f7bbc4b1e06207c642f424b212d7add68e99900a9265f13fde89'
export const MODEL = Object.freeze({ harness: 'claude_code', model: 'claude-haiku-5-5', provider: 'claude' })
const ORIGIN = 'https://app.aspectlylabs.com', API = 'https://api.github.com/repos/alexj11324/Mikka'
const WORKFLOW = '.github/workflows/issue1782-publication-fixture.yml', BRANCH = 'ops/self-hosted-vault-closeout-20261108'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const TERMINAL = new Set(['succeeded', 'stopped', 'failed', 'cancelled'])
const MODELS = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const exact = (row, keys) => row && typeof row === 'object' && !Array.isArray(row)
  && isDeepStrictEqual(Object.keys(row).sort(), [...keys].sort())
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const positive = value => Number.isSafeInteger(value) && value > 0
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const CODES = new Set(['binding_refused', 'source_refused', 'window_changed', 'window_expired', 'runtime_active', 'main_changed',
  'build_changed', 'account_refused', 'workspace_refused', 'resource_changed', 'source_ambiguous', 'old_run_changed',
  'fixture_bytes_changed', 'request_refused', 'duplicate_mutation', 'task_create_uncertain', 'task_invalid', 'bot_busy',
  'dispatch_unknown', 'dispatch_refused', 'dispatch_missing', 'dispatch_multiple', 'stream_invalid', 'run_scope_changed',
  'run_failed', 'publication_invalid', 'cleanup_failed', 'signout_failed', 'http_failed', 'budget_exhausted', 'fixture_failed'])
export const publicFailure = error => ({ code: CODES.has(error?.code) ? error.code : 'fixture_failed' })

const CLIENT_BUDGETS = new WeakMap(), REQUEST_CAP = Symbol('fixtureRequestCap')
const budgetError = () => Object.assign(new Error('budget_exhausted'), { code: 'budget_exhausted' })
function abortable(signal, work, late = () => {}) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (accept, value) => {
      if (settled) return false
      settled = true; signal.removeEventListener('abort', abort); accept(value); return true
    }
    const abort = () => finish(reject, signal.reason ?? budgetError())
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return work() }).then(value => {
      if (!finish(resolve, value)) Promise.resolve().then(() => late(value)).catch(() => {})
    }, error => finish(reject, error))
  })
}

/** Only compiled callers may shrink these budgets for offline timing tests.
 * Production has 25 minutes total, four reserved for cleanup, including the
 * last fifteen seconds for an independent signout acknowledgement. */
export function createCaptureBudget(b, { now = Date.now, totalMs = 25 * 60000,
  cleanupReserveMs = 4 * 60000, signoutReserveMs = 15000 } = {}) {
  check([totalMs, cleanupReserveMs, signoutReserveMs].every(positive)
    && totalMs <= 25 * 60000 && cleanupReserveMs <= 4 * 60000 && signoutReserveMs <= 15000
    && cleanupReserveMs >= totalMs * 4 / 25 && signoutReserveMs >= totalMs / 100
    && totalMs > cleanupReserveMs && cleanupReserveMs > signoutReserveMs && iso(b.windowExpiresAt), 'binding_refused')
  const startedAt = now(), end = Math.min(startedAt + totalMs, Date.parse(b.windowExpiresAt))
  check(Number.isFinite(startedAt) && end - startedAt > cleanupReserveMs, 'budget_exhausted')
  const deadlines = { work: end - cleanupReserveMs, cleanup: end - signoutReserveMs, signout: end }
  const controllers = Object.fromEntries(Object.keys(deadlines).map(phase => [phase, new AbortController()]))
  const timers = new Set(), leases = new Set(); let disposed = false, phase = 'work'
  const stopTimer = timer => { clearTimeout(timer); timers.delete(timer) }
  const later = (ms, action) => { const timer = setTimeout(() => { timers.delete(timer); action() }, ms); timers.add(timer); return timer }
  const remaining = (kind, cap = Number.MAX_SAFE_INTEGER) => {
    check(Object.hasOwn(deadlines, kind) && positive(cap), 'binding_refused')
    const left = Math.ceil(deadlines[kind] - now())
    if (disposed || controllers[kind].signal.aborted || left <= 0) {
      controllers[kind].abort(budgetError()); throw budgetError()
    }
    return Math.min(left, cap)
  }
  for (const kind of Object.keys(deadlines)) later(deadlines[kind] - startedAt, () => controllers[kind].abort(budgetError())).unref?.()
  const budget = {
    now, signal: kind => { check(Object.hasOwn(controllers, kind), 'binding_refused'); return controllers[kind].signal },
    remaining,
    lease(kind, cap, external) {
      const ms = remaining(kind, cap), controller = new AbortController()
      const signals = [...new Set([controllers[kind].signal, external].filter(Boolean))]
      const listeners = signals.map(signal => [signal, () => controller.abort(signal.reason ?? budgetError())])
      for (const [signal, listener] of listeners) { if (signal.aborted) listener(); else signal.addEventListener('abort', listener, { once: true }) }
      const timer = later(ms, () => controller.abort(budgetError())); let done = false
      const lease = { signal: controller.signal, dispose() {
        if (done) return; done = true; stopTimer(timer)
        for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
        leases.delete(lease)
      } }
      leases.add(lease); return lease
    },
    async run(kind, cap, work) {
      const lease = budget.lease(kind, cap)
      try { return await abortable(lease.signal, () => work(lease.signal)) } finally { lease.dispose() }
    },
    enterCleanup() {
      check(!disposed && phase !== 'signout', 'budget_exhausted'); phase = 'cleanup'; controllers.work.abort(budgetError())
    },
    enterSignout() { check(!disposed, 'budget_exhausted'); phase = 'signout'; controllers.work.abort(budgetError()); controllers.cleanup.abort(budgetError()) },
    dispose() {
      if (disposed) return; disposed = true
      for (const controller of Object.values(controllers)) controller.abort(budgetError())
      for (const lease of leases) lease.dispose()
      for (const timer of timers) stopTimer(timer)
    },
    get activeTimers() { return timers.size },
    get phase() { return phase },
    summary: () => ({ totalMs, cleanupReserveMs, signoutReserveMs, startedAt: new Date(startedAt).toISOString(),
      workDeadline: new Date(deadlines.work).toISOString(), cleanupDeadline: new Date(deadlines.cleanup).toISOString(), hardDeadline: new Date(end).toISOString() }),
  }
  return budget
}

/** Keep the same abort lease until a JSON or NDJSON body is actually consumed.
 * An ignored/late fetch cannot turn into a later authorized mutation or read. */
async function budgetedFetch(fetchImpl, url, init, budget, phase, cap) {
  const lease = budget.lease(phase, cap, init.signal)
  let response
  try { response = await abortable(lease.signal, () => fetchImpl(url, { ...init, signal: lease.signal }), value => value.body?.cancel()) }
  catch (error) { lease.dispose(); throw error }
  if (!response.body) { lease.dispose(); return response }
  const reader = response.body.getReader(); let finished = false, output
  const finish = () => { if (finished) return; finished = true; lease.signal.removeEventListener('abort', aborted); lease.dispose() }
  const aborted = () => {
    if (finished) return
    output.error(lease.signal.reason ?? budgetError()); reader.cancel().catch(() => {}); finish()
  }
  const body = new ReadableStream({
    start(controller) { output = controller; lease.signal.addEventListener('abort', aborted, { once: true }); if (lease.signal.aborted) aborted() },
    async pull(controller) {
      try {
        const item = await reader.read(); if (finished) return
        if (item.done) { controller.close(); finish() } else controller.enqueue(item.value)
      } catch (error) { if (!finished) { controller.error(error); finish() } }
    },
    cancel(reason) { finish(); reader.cancel(reason).catch(() => {}) },
  }, { highWaterMark: 0 })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

export function createFixtureClient(b, state, budget, fetchImpl = fetch) {
  check(budget && typeof budget.lease === 'function', 'binding_refused')
  const phaseFor = path => path === '/api/auth/sign-out' ? 'signout' : state.cleanup ? 'cleanup' : 'work'
  const prepared = (path, init = {}, timeoutMs = 30000) => ({ ...init,
    [REQUEST_CAP]: phaseFor(path) === 'signout' ? Math.min(timeoutMs, budget.summary().signoutReserveMs) : timeoutMs,
    signal: init.signal ?? (phaseFor(path) === 'work' ? state.workSignal : null) ?? budget.signal(phaseFor(path)) })
  const session = createSessionClient(ORIGIN, (url, init) => {
    const phase = phaseFor(url.pathname.replace(/^\/mikka/, '')), cap = init[REQUEST_CAP]
    budget.remaining(phase, cap)
    const request = { ...init, headers: { ...init.headers, 'x-mikka-workspace-id': b.workspaceId } }; delete request[REQUEST_CAP]
    assertRequest(url, request, b, state)
    return budgetedFetch(fetchImpl, url, request, budget, phase, cap)
  })
  const client = {
    request: (path, init, timeoutMs) => session.request(path, prepared(path, init, timeoutMs), timeoutMs),
    json: (path, init, timeoutMs) => session.json(path, prepared(path, init, timeoutMs), timeoutMs),
    async rpc(action, args, extra = {}) {
      const response = await client.json('/api/rpc', { ...post({ version: 1, action, args }),
        headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1', ...extra.headers }, ...(extra.signal ? { signal: extra.signal } : {}) }, extra.timeoutMs)
      check(response.ok === true, 'request_refused'); const value = decodeWire(response.result)
      check(!value?.error && value?.ok !== false, 'request_refused')
      return value?.ok === true && 'data' in value ? value.data : value
    },
    clear: () => session.clear(),
  }
  CLIENT_BUDGETS.set(client, budget); return client
}

// Fill only from root-verified actual preflight/own setup receipts. A missing
// owned Bot/Profile is normally created through the product before this source
// is bound; it is not an Alex-only credential dependency. No env/CLI overrides.
export const BINDING = Object.freeze({ applicationSha: null, workspaceId: null, readerSha256: null, policyAdminSha256: null,
  opsParentSha: null, preflightRunId: null, preflightOpsSource: null, preflightEvidenceSha256: null,
  botId: null, botCreationReceiptSha256: null, chatChoiceId: null, subscriptionConnectionId: null,
  profileId: null, profileVersion: null, profileDigest: null, reviewProfilePins: null,
  repositoryBaseSha: null, oldRunWitness: null, windowCommentId: null, windowCommentBodySha256: null,
  windowStartsAt: null, windowExpiresAt: null })

export function checkBinding(b = BINDING) {
  check(exact(b, Object.keys(BINDING)) && ['applicationSha', 'opsParentSha', 'preflightOpsSource', 'repositoryBaseSha'].every(k => SHA.test(b[k] ?? ''))
    && ['workspaceId', 'botId', 'chatChoiceId', 'subscriptionConnectionId', 'profileId'].every(k => UUID.test(b[k] ?? ''))
    && ['readerSha256', 'policyAdminSha256', 'preflightEvidenceSha256', 'botCreationReceiptSha256', 'profileDigest', 'windowCommentBodySha256'].every(k => DIGEST.test(b[k] ?? ''))
    && positive(b.preflightRunId) && positive(b.profileVersion) && positive(b.windowCommentId)
    && iso(b.windowStartsAt) && iso(b.windowExpiresAt) && Date.parse(b.windowExpiresAt) > Date.parse(b.windowStartsAt)
    && Date.parse(b.windowExpiresAt) - Date.parse(b.windowStartsAt) <= 45 * 60000, 'binding_refused')
  const w = b.oldRunWitness
  check(exact(w, ['taskId', 'runId', 'createdAt', 'observedAt', 'observedStatus', 'creatorSha256', 'accessMode', 'deletedAtSha256'])
    && UUID.test(w.taskId) && UUID.test(w.runId) && iso(w.createdAt) && iso(w.observedAt)
    && Date.parse(w.createdAt) <= Date.parse(w.observedAt) && Date.parse(w.observedAt) <= Date.parse(b.windowStartsAt)
    && TERMINAL.has(w.observedStatus) && DIGEST.test(w.creatorSha256)
    && (w.accessMode === 'live' && w.deletedAtSha256 === null || w.accessMode === 'owned_deleted'
      && w.creatorSha256 === b.readerSha256 && DIGEST.test(w.deletedAtSha256)), 'binding_refused')
  check(Array.isArray(b.reviewProfilePins) && b.reviewProfilePins.length > 0 && b.reviewProfilePins.length <= 10
    && b.reviewProfilePins.every(p => exact(p, ['id', 'version', 'digest', 'harness', 'model', 'connectionId'])
      && UUID.test(p.id) && positive(p.version) && DIGEST.test(p.digest) && MODELS[p.harness] === p.model && UUID.test(p.connectionId))
    && new Set(b.reviewProfilePins.map(p => p.id)).size === b.reviewProfilePins.length
    && b.reviewProfilePins.some(p => p.id === b.profileId && p.version === b.profileVersion && p.digest === b.profileDigest
      && p.harness === MODEL.harness && p.model === MODEL.model && p.connectionId === b.subscriptionConnectionId), 'binding_refused')
  return b
}
export function windowRecord(b = BINDING) {
  return { state: 'active', batch: 1782, mode: 'owned_publication_fixture', mainSha: b.applicationSha,
    workspaceSha256: hash(b.workspaceId), opsParentSha: b.opsParentSha, preflightRunId: b.preflightRunId,
    startsAt: b.windowStartsAt, expiresAt: b.windowExpiresAt }
}
export function guardContext(env, event, checkout, parents, dirty, b = BINDING) {
  workflowGuard(env); checkBinding(b)
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_WORKFLOW_REF === `alexj11324/Mikka/${WORKFLOW}@refs/heads/${BRANCH}`
    && env.GITHUB_JOB === 'publication_fixture' && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_TRIGGERING_ACTOR === 'alexj11324'
    && event.repository?.id === 1427517699 && event.repository.owner?.id === 183887963 && event.ref === env.GITHUB_REF
    && event.after === env.GITHUB_SHA && event.before === b.opsParentSha && event.forced === false && event.deleted === false
    && checkout === env.GITHUB_SHA && isDeepStrictEqual(parents, [b.opsParentSha]) && !dirty, 'source_refused')
}
export async function guardMain(env, b = BINDING, fetchImpl = fetch, now = Date.now, remainingMs = 0, budget) {
  checkBinding(b)
  const time = () => { const at = now(); check(at >= Date.parse(b.windowStartsAt) && at + remainingMs < Date.parse(b.windowExpiresAt), 'window_expired'); return at }
  time(); check(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0, 'source_refused')
  const read = async (url, github = true) => {
    const init = { redirect: 'error', headers: { 'cache-control': 'no-store',
      ...(github ? { authorization: 'Bearer ' + env.GITHUB_TOKEN, accept: 'application/vnd.github+json' } : {}) } }
    const r = budget ? await budgetedFetch(fetchImpl, url, init, budget, 'work', 15000)
      : await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) })
    check(r.ok, 'http_failed'); return r.json()
  }
  const main = await read(API + '/git/ref/heads/main')
  check(main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === b.applicationSha, 'main_changed')
  const version = await read(ORIGIN + '/mikka/api/version?verify=1782-publication-' + now(), false)
  check(version.build === b.applicationSha, 'build_changed')
  const issue = await read(API + '/issues/1752'); check(issue.number === 1752 && positive(issue.comments), 'window_changed')
  const comments = await read(API + '/issues/1752/comments?per_page=1&page=' + issue.comments), c = comments?.[0]
  check(Array.isArray(comments) && comments.length === 1 && c.id === b.windowCommentId && c.user?.login === 'alexj11324'
    && c.user.id === 183887963 && c.issue_url === API + '/issues/1752' && typeof c.body === 'string' && hash(c.body) === b.windowCommentBodySha256, 'window_changed')
  const marker = '<!-- mikka-1782-publication-fixture:v1\n', start = c.body.indexOf(marker), end = c.body.indexOf('\n-->', start)
  check(start >= 0 && end > start && c.body.indexOf(marker, start + marker.length) < 0, 'window_changed')
  let value; try { value = JSON.parse(c.body.slice(start + marker.length, end)) } catch { check(false, 'window_changed') }
  check(isDeepStrictEqual(value, windowRecord(b)), 'window_changed')
  const preflight = await read(API + '/actions/runs/' + b.preflightRunId)
  check(preflight.head_sha === b.preflightOpsSource && preflight.event === 'push' && preflight.run_attempt === 1
    && preflight.path === '.github/workflows/issue1782-publication-preflight.yml' && preflight.status === 'completed'
    && preflight.conclusion === 'success' && preflight.repository?.full_name === 'alexj11324/Mikka', 'source_refused')
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const runs = await read(API + '/actions/workflows/e2b-official-runtime.yml/runs?branch=main&status=' + status + '&per_page=1')
    check(runs.total_count === 0 && Array.isArray(runs.workflow_runs) && runs.workflow_runs.length === 0, 'runtime_active')
  }
  return { mainSha: b.applicationSha, servedBuild: version.build, checkedAt: new Date(time()).toISOString(),
    windowCommentId: b.windowCommentId, officialRuntimeIdle: true, preflightRunId: b.preflightRunId }
}

export function fixtureDocument(b, text, sourceSha) {
  check(hash(text) === FIXTURE_SHA256 && SHA.test(sourceSha), 'fixture_bytes_changed')
  const fingerprint = hash(JSON.stringify([sourceSha, b.applicationSha, b.botId, b.profileId, b.profileVersion,
    b.profileDigest, b.preflightEvidenceSha256, b.oldRunWitness.runId, FIXTURE_SHA256]))
  const h = hash('1782-publication:' + fingerprint), submissionId = `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`
  const work = `在已授权的 ${REPOSITORY} 中完成一个真实文档改动。首先确认 origin 是此仓库、base main 的精确 commit 是 ${b.repositoryBaseSha}，工作树干净，路径 ${FIXTURE_PATH} 尚不存在；任一不符就停止并报告，不覆盖。只新增这一个 Markdown 文件，UTF-8、LF、末尾换行，全文如下：\n${text}\n文件 SHA-256 必须为 ${FIXTURE_SHA256}。使用正常工具独立核对文件字节 SHA-256 和 git diff 的唯一路径；不修改 workflow、其他文件、配置或共享资源。按当前 Task 的系统分支规则 commit 并非 force push HEAD，使用正常 gh 在 ${REPOSITORY} 创建或更新本 Task 的 PR，body 末行必须是系统提供的精确 <!-- mikka-issue:Task UUID --> 标记。等待该 PR 最新 commit 的所有真实 checks SUCCESS，再用正常 submit 交付；CI 不替代本文件字节/路径核验。不要 merge、部署、读凭据、发布外部消息、派生其他 Agent 或伪造任何回执。若需要权限或操作不被正常账户允许，保留真实阻碍。`
  return { fingerprint, submissionId, title: 'Coding Workspace 迁移前后历史核验说明',
    content: { type: 'doc', content: [work, '验收来源：新建 pre-migration fixture；不是存量历史。fingerprint=' + fingerprint]
      .map(value => ({ type: 'paragraph', content: [{ type: 'text', text: value }] })) } }
}

export async function pinResources(client, scope, b) {
  const results = await Promise.allSettled([client.json('/api/integrations/github'),
    client.json('/api/factory/agent-profiles?workspaceId=' + b.workspaceId + '&location=cloud'),
    client.rpc('model-order.getModelOrder', [b.workspaceId]), client.rpc('bots.pollBots', []),
    client.json('/api/settings/api-keys?workspace=' + b.workspaceId), client.json('/api/bots/' + b.botId),
    client.rpc('coordinator.pollCoordinatorChat', [b.botId]), client.rpc('execution-settings.getBotModelMenu', [b.botId])])
  const failed = results.find(r => r.status === 'rejected'); if (failed) throw failed.reason
  const [github, management, order, bots, keys, bot, chat, menu] = results.map(r => r.value)
  check(github.viewerId === scope.ownerId && github.connected === true && github.installed === true
    && Array.isArray(github.repositories) && github.repositories.filter(r => r.fullName === REPOSITORY).length === 1, 'resource_changed')
  check(bots.live?.ownerId === scope.ownerId && bots.live.workspaceId === b.workspaceId && Array.isArray(bots.items)
    && bots.items.filter(r => r.id === b.botId).length === 1 && bot.id === b.botId, 'resource_changed')
  check(chat.botId === b.botId && chat.enabled === true && chat.working === false && !chat.streamRunId, 'bot_busy')
  check(Array.isArray(order.candidates) && order.candidates.length <= 1000 && Array.isArray(menu.groups), 'resource_changed')
  const primarySources = order.candidates.filter(c => c.harness === MODEL.harness && c.model === MODEL.model && c.source?.kind === 'subscription')
  check(primarySources.length === 1 && primarySources[0].source.connectionId === b.subscriptionConnectionId
    && primarySources[0].credentialOwnerId === scope.adminId, 'source_ambiguous')
  const options = menu.groups.filter(g => g.kind === 'subscription' && g.provider === MODEL.provider && typeof g.owner === 'string' && g.owner.length > 0)
    .flatMap(g => g.options ?? []).filter(o => o.provider === MODEL.provider && o.modelId === MODEL.model)
  check(options.length === 1 && options[0].id === b.chatChoiceId && menu.current?.id === b.chatChoiceId
    && menu.current.kind === 'subscription' && menu.current.provider === MODEL.provider && menu.current.modelId === MODEL.model
    && menu.current.chosen === true && menu.current.fallback === undefined
    && (menu.current.available === true || menu.current.availability === 'checking'), 'source_ambiguous')
  check(keys.apiKeyAfterQuota === false, 'resource_changed')
  check(Array.isArray(management.profiles) && management.profiles.length < 101 && management.availability, 'resource_changed')
  const enabled = management.profiles.filter(p => p.enabled && !p.archivedAt)
  check(enabled.length === b.reviewProfilePins.length && enabled.every(p => b.reviewProfilePins.some(pin =>
    p.id === pin.id && p.version === pin.version && p.digest === pin.digest && ['auto', pin.harness].includes(p.harness)
    && p.model?.mode === 'fixed' && p.model.harness === pin.harness && p.model.model === pin.model
    && p.model.source?.kind === 'subscription' && p.model.source.connectionId === pin.connectionId
    && order.candidates.some(c => c.harness === pin.harness && c.model === pin.model && c.source?.kind === 'subscription'
      && c.source.connectionId === pin.connectionId && c.credentialOwnerId === scope.adminId))), 'resource_changed')
  const profile = enabled.find(p => p.id === b.profileId)
  check(profile && profile.version === b.profileVersion && profile.digest === b.profileDigest && profile.instructions === ''
    && Array.isArray(profile.skills) && profile.skills.length === 0 && Array.isArray(profile.roles) && profile.roles.length === 0
    && management.availability[b.profileId]?.available === true, 'resource_changed')
  return profile
}

export async function verifyOldRun(client, scope, b) {
  const old = b.oldRunWitness, listing = await client.rpc('task-runs.pollThreads', [])
  check(Array.isArray(listing?.items) && listing.items.length <= 200 && !listing.unchanged && !listing.delta, 'old_run_changed')
  const rows = listing.items.filter(r => r.id === old.runId)
  check(rows.length === 1 && rows[0].issueId === old.taskId && rows[0].createdAt === old.createdAt
    && TERMINAL.has(rows[0].status), 'old_run_changed')
  const access = await readHistoryTaskAccess(client, scope, old.taskId)
  check(hash(access.creator) === old.creatorSha256, 'old_run_changed')
  return { ...old, reauthorized: true, currentAccessMode: access.mode,
    requiresExactReadonlyAppRecheck: true, preflightEvidenceSha256: b.preflightEvidenceSha256 }
}

export function newState() { return { issueId: null, runIds: new Set(), discoveryRunIds: new Set(), factoryId: null, taskInput: null,
  dispatchArgs: null, createCalls: 0, dispatchCalls: 0, cancelCalls: 0, cleanup: false } }
export function assertRequest(url, init, b, state) {
  const u = new URL(url), method = init.method ?? 'GET', p = u.pathname.replace(/^\/mikka/, '')
  check(u.origin === ORIGIN && u.pathname.startsWith('/mikka/') && !u.hash, 'request_refused')
  const q = Object.fromEntries(u.searchParams); check(u.searchParams.size === Object.keys(q).length, 'request_refused')
  if (method === 'GET') {
    const fixed = new Map([['/api/auth/get-session', {}], ['/api/workspace', { workspace: b.workspaceId }],
      ['/api/integrations/github', {}], ['/api/factory/agent-profiles', { workspaceId: b.workspaceId, location: 'cloud' }],
      ['/api/settings/api-keys', { workspace: b.workspaceId }], ['/api/bots/' + b.botId, {}],
      ['/api/coordinator/stream', { botId: b.botId, wait: '1' }], ['/api/live/ticket', { workspace: b.workspaceId }]])
    if (state.issueId) fixed.set('/api/factory/tasks', { issueId: state.issueId })
    if (state.factoryId) {
      fixed.set('/api/factory/tasks/' + state.factoryId, {})
      fixed.set('/api/factory/tasks/' + state.factoryId + '/flow', {})
      fixed.set('/api/factory/tasks/' + state.factoryId + '/activity', {})
    }
    for (const id of new Set([...state.runIds, ...(state.discoveryRunIds ?? [])])) fixed.set('/api/runs/' + id + '/evidence', {})
    check(fixed.has(p) && isDeepStrictEqual(q, fixed.get(p)), 'request_refused'); return
  }
  check(method === 'POST' && u.search === '' && typeof init.body === 'string', 'request_refused')
  let body; try { body = JSON.parse(init.body) } catch { check(false, 'request_refused') }
  if (p === '/api/auth/sign-in/email') { check(exact(body, ['email', 'password', 'rememberMe']) && body.rememberMe === false, 'request_refused'); return }
  if (p === '/api/auth/sign-out') { check(exact(body, []), 'request_refused'); return }
  if (state.cleanup && state.factoryId && p === '/api/factory/tasks/' + state.factoryId) {
    check(isDeepStrictEqual(body, state.cancelInput), 'request_refused'); check(state.cancelCalls++ === 0, 'duplicate_mutation'); return
  }
  if (state.cleanup && [...state.runIds].some(id => p === '/api/threads/' + id + '/machine')) {
    check(isDeepStrictEqual(body, { action: 'end' }), 'request_refused'); return
  }
  check(p === '/api/rpc' && exact(body, ['version', 'action', 'args']) && body.version === 1 && Array.isArray(body.args)
    && new Headers(init.headers).get('x-mikka-workspace-id') === b.workspaceId, 'request_refused')
  const a = body.args
  if (body.action === 'issues.saveIssue') {
    check(!state.cleanup && state.taskInput && isDeepStrictEqual(a, [state.taskInput]), 'request_refused')
    check(state.createCalls++ === 0, 'duplicate_mutation'); return
  }
  if (body.action === 'coordinator.sendCoordinatorMessage') {
    check(!state.cleanup && state.issueId && state.dispatchArgs && isDeepStrictEqual(a, state.dispatchArgs), 'request_refused')
    check(state.dispatchCalls++ === 0, 'duplicate_mutation'); return
  }
  const ids = [b.oldRunWitness.taskId, state.issueId].filter(Boolean)
  const allowed = ['bots.pollBots', 'task-runs.pollThreads'].includes(body.action) && a.length === 0
    || body.action === 'model-order.getModelOrder' && isDeepStrictEqual(a, [b.workspaceId])
    || ['coordinator.pollCoordinatorChat', 'execution-settings.getBotModelMenu'].includes(body.action) && isDeepStrictEqual(a, [b.botId])
    || state.cleanup && body.action === 'coordinator.stopCoordinatorTurn' && isDeepStrictEqual(a, [b.botId])
    || ['issues.getIssue', 'issue-operations.getDeletedIssue'].includes(body.action) && a.length === 1 && ids.includes(a[0])
    || body.action === 'agents.pollIssueThreads' && state.issueId && isDeepStrictEqual(a, [state.issueId])
    || ['agents.getIssueThread', 'agents.getThreadMachine'].includes(body.action) && a.length === 2
      && a[0] === state.issueId && (state.runIds.has(a[1]) || body.action === 'agents.getIssueThread' && state.discoveryRunIds?.has(a[1]))
  check(allowed, 'request_refused')
}

export function dispatchArguments(record, b) {
  const marker = '[1782:' + record.submissionId + ']'
  const input = { issueId: record.issueId, repo: REPOSITORY, target: 'cloud', profileId: b.profileId,
    readOnly: false, note: marker + ' 执行已有 Task 的精确单文件真实交付，保持其固定 Profile、官方订阅和服务端 Task 分支。' }
  const text = '只执行已有 Task ' + record.issueId + '，不创建新 Task。仅调用一次 dispatch_run，参数：' + JSON.stringify(input)
    + '。不用 needsSpec，不改模型/Profile/订阅，不合并或部署。派发后只确认实际 runId。'
  return [text, null, b.botId, record.submissionId, { kind: 'cloud' }, null, [], { $mikka: 'undefined' }, b.profileId]
}
const previewId = (s, key) => typeof s === 'string' ? new RegExp('"' + key + '"\\s*:\\s*"([a-f0-9-]{36})"').exec(s)?.[1] : null
export async function dispatch(client, record, b, state, timeoutMs, signal) {
  state.dispatchArgs = dispatchArguments(record, b); record.submitted = true
  await client.rpc('coordinator.sendCoordinatorMessage', state.dispatchArgs, { signal })
  const response = await client.request('/api/coordinator/stream?botId=' + b.botId + '&wait=1', signal ? { signal } : {}, timeoutMs)
  check(response.ok && response.body && response.headers.get('content-type')?.includes('application/x-ndjson'), 'stream_invalid')
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', bytes = 0, call
  try {
    for (;;) {
      const { value, done } = await reader.read(); bytes += value?.length ?? 0; check(bytes <= 1000000, 'stream_invalid')
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let event; try { event = JSON.parse(line) } catch { check(false, 'stream_invalid') }
        if (event.type !== 'tool' || event.name !== 'dispatch_run') continue
        if (event.state === 'running' && previewId(event.input, 'issueId') === record.issueId
          && typeof event.quote === 'string' && event.quote.startsWith('[1782:' + record.submissionId + '] ')) {
          check(!call || call === event.call, 'dispatch_multiple'); call = event.call
        }
        if (!call || event.call !== call || event.state === 'running') continue
        check(event.state === 'done', 'dispatch_refused')
        const { threads } = await client.rpc('agents.pollIssueThreads', [record.issueId], { signal })
        check(Array.isArray(threads) && threads.length === 1 && UUID.test(threads[0].id) && threads[0].ownedByCurrentUser === true, 'dispatch_missing')
        const returned = previewId(event.output, 'runId'); check(!returned || returned === threads[0].id, 'dispatch_missing')
        record.runId = threads[0].id; state.runIds.add(record.runId); record.dispatchSettled = true; return
      }
      if (done) check(false, 'dispatch_missing')
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function factoryScope(snapshot, scope, record, b) {
  const t = snapshot.task
  check(t && UUID.test(t.id) && t.issueId === record.issueId && t.userId === scope.ownerId && t.workspaceId === b.workspaceId
    && t.botId === b.botId && UUID.test(t.sourceEventId) && positive(t.revision)
    && Array.isArray(snapshot.attempts) && snapshot.attempts.length <= 20 && Array.isArray(snapshot.candidates)
    && snapshot.candidates.length <= 20, 'run_scope_changed')
  if (record.factoryBinding) check(t.id === record.factoryBinding.id && t.sourceEventId === record.factoryBinding.sourceEventId, 'run_scope_changed')
  check(snapshot.attempts.every(a => a.taskId === t.id && a.output?.requestEpoch === t.sourceEventId && (!a.runId || UUID.test(a.runId))), 'run_scope_changed')
  return snapshot
}
export function validateFactory(snapshot, scope, record, b) {
  factoryScope(snapshot, scope, record, b)
  const t = snapshot.task
  check(snapshot.attempts.some(a => a.runId === record.runId), 'run_scope_changed')
  record.factoryBinding ??= { id: t.id, sourceEventId: t.sourceEventId }
  return snapshot
}
export function publicationReceipt(snapshot, flow, record) {
  const candidates = snapshot.candidates.filter(c => c.id === snapshot.task.candidateId && c.runId === record.runId)
  check(candidates.length <= 1, 'publication_invalid'); if (!candidates.length || !flow.pullRequest) return null
  const c = candidates[0], url = flow.pullRequest.url
  check(c.taskId === snapshot.task.id && c.kind === 'repository' && SHA.test(c.sha) && c.scope === 'issue:' + record.issueId
    && ['https://github.com/' + REPOSITORY, 'https://github.com/' + REPOSITORY + '.git'].includes(c.repository)
    && flow.version === 2 && flow.id === snapshot.task.id && flow.issueId === record.issueId
    && flow.botId === snapshot.task.botId && flow.pullRequest.state === 'open'
    && typeof url === 'string' && /^https:\/\/github\.com\/alexj11324\/Mikka-handoff\/pull\/[1-9][0-9]*$/.test(url), 'publication_invalid')
  return { taskId: record.issueId, runId: record.runId, factoryId: snapshot.task.id, candidateId: c.id, commitSha: c.sha,
    pullRequestUrl: url, normalServerPublicationProjection: true, independentGithubVerificationRequired: true,
    exactReadonlyAppPublishedRowRequired: true }
}

/** The normal activity endpoint selects only durable published receipts. Its
 * exact execution attempt is independent of the Factory's current review stage. */
export function publishedActivityReceipt(snapshot, flow, activity, record, b) {
  const receipt = publicationReceipt(snapshot, flow, record)
  if (!receipt) return null
  check(activity?.version === 1 && iso(activity.observedAt) && activity.liveWorkspaceId === b.workspaceId
    && activity.task?.version === 2 && activity.task.id === snapshot.task.id
    && activity.task.issueId === record.issueId && activity.task.botId === b.botId
    && Array.isArray(activity.artifacts) && activity.artifacts.length <= 200, 'publication_invalid')
  const attempts = snapshot.attempts.filter(a => a.taskId === snapshot.task.id && a.runId === record.runId
    && a.stage === 'execute' && a.candidateId === receipt.candidateId && a.output?.requestEpoch === snapshot.task.sourceEventId)
  check(attempts.length === 1 && UUID.test(attempts[0].id), 'publication_invalid')
  const artifacts = activity.artifacts.filter(a => a.kind === 'pull_request'
    && (a.runId === record.runId || a.id === 'pr:' + record.runId))
  check(artifacts.length <= 1, 'publication_invalid')
  if (!artifacts.length) return null
  const artifact = artifacts[0]
  check(activity.task.pullRequest?.url === receipt.pullRequestUrl && activity.task.pullRequest.state === 'open'
    && artifact.id === 'pr:' + record.runId && artifact.runId === record.runId
    && artifact.attemptId === attempts[0].id && artifact.candidateId === receipt.candidateId
    && artifact.state === 'open' && artifact.url === receipt.pullRequestUrl && iso(artifact.createdAt), 'publication_invalid')
  return { ...receipt, publishedActivity: { version: 1, artifactId: artifact.id, attemptId: artifact.attemptId,
    createdAt: artifact.createdAt, observedAt: activity.observedAt, normalPublishedStatusFilter: true } }
}

async function readFactory(client, scope, record, b, state) {
  if (!state.factoryId) {
    const listing = await client.json('/api/factory/tasks?issueId=' + record.issueId)
    check(listing.issueId === record.issueId && listing.liveWorkspaceId === b.workspaceId && Array.isArray(listing.tasks)
      && listing.tasks.length === 1 && UUID.test(listing.tasks[0].id), 'run_scope_changed')
    state.factoryId = listing.tasks[0].id
  }
  const snapshot = validateFactory(await client.json('/api/factory/tasks/' + state.factoryId), scope, record, b)
  const ids = new Set([...state.runIds, ...snapshot.attempts.map(attempt => attempt.runId).filter(Boolean)])
  check(ids.size <= 10, 'run_scope_changed')
  for (const id of ids) state.runIds.add(id)
  return snapshot
}
async function verifyRun(client, scope, id, record, b) {
  const { run } = await client.json('/api/runs/' + id + '/evidence'), identity = run?.executionIdentity
  const pin = b.reviewProfilePins.find(p => p.id === run?.agentProfile?.profileId)
  const subscriptions = identity?.resourceBindings?.filter(r => r.kind === 'subscription') ?? []
  check(run?.id === id && run.issueId === record.issueId && run.botId === b.botId && pin
    && run.harness === pin.harness && run.model === pin.model && run.credentialType === 'subscription'
    && run.subscriptionRoute === (pin.harness === 'claude_code' ? 'claude_code_cli' : 'codex_cli')
    && run.agentProfile.version === pin.version && run.agentProfile.digest === pin.digest
    && identity?.version === 1 && identity.requester === scope.ownerId && identity.outputOwner === scope.ownerId
    && identity.executionPrincipal === scope.ownerId && identity.botOwner === scope.ownerId && identity.botId === b.botId
    && identity.workspaceId === b.workspaceId && identity.personalResourcePolicy === 'requester_only'
    && subscriptions.length === 1 && subscriptions[0].ownerId === scope.adminId && subscriptions[0].access === 'workspace_share'
    && UUID.test(subscriptions[0].id) && identity.billingAccount?.model?.kind === 'subscription'
    && identity.billingAccount.model.ownerId === scope.adminId && identity.billingAccount.model.resourceId === subscriptions[0].id
    && identity.billingAccount.runtime.kind === 'e2b' && identity.billingAccount.runtime.ownerId === scope.ownerId
    && identity.billingAccount.runtime.resourceId === scope.ownerId, 'run_scope_changed')
  if (id === record.runId) check(run.agentProfile.profileId === b.profileId && run.agentProfile.source === 'explicit', 'run_scope_changed')
  return { id, status: run.status, harness: run.harness, model: run.model, profileId: pin.id,
    profileVersion: pin.version, profileDigest: pin.digest, subscriptionBindingSha256: hash(subscriptions[0].id) }
}

async function discoverCleanupRuns(client, scope, record, b, state) {
  const access = await readHistoryTaskAccess(client, scope, record.issueId, scope.ownerId)
  check(access.creator === scope.ownerId, 'run_scope_changed')
  const { threads } = await client.rpc('agents.pollIssueThreads', [record.issueId])
  check(Array.isArray(threads) && threads.length <= 10 && threads.every(t => UUID.test(t.id))
    && new Set(threads.map(t => t.id)).size === threads.length, 'run_scope_changed')
  const listing = await client.json('/api/factory/tasks?issueId=' + record.issueId)
  check(listing.issueId === record.issueId && listing.liveWorkspaceId === b.workspaceId && Array.isArray(listing.tasks)
    && listing.tasks.length <= 1 && listing.tasks.every(t => UUID.test(t.id)), 'run_scope_changed')
  if (!listing.tasks.length) { check(threads.length === 0, 'run_scope_changed'); return null }
  if (state.factoryId) check(state.factoryId === listing.tasks[0].id, 'run_scope_changed')
  state.factoryId = listing.tasks[0].id
  const snapshot = factoryScope(await client.json('/api/factory/tasks/' + state.factoryId), scope, record, b)
  const epochIds = new Set(snapshot.attempts.map(a => a.runId).filter(Boolean))
  check(epochIds.size <= 10 && threads.every(t => t.ownedByCurrentUser === true && epochIds.has(t.id)), 'run_scope_changed')
  const ids = new Set([...epochIds, ...threads.map(t => t.id)])
  check(new Set([...state.runIds, ...ids]).size <= 10, 'run_scope_changed')
  state.discoveryRunIds = ids
  // This is cleanup authority only. It never supplies a guessed producer or
  // turns an unacknowledged dispatch into successful execution evidence.
  record.cleanupFactoryBinding = { id: snapshot.task.id, sourceEventId: snapshot.task.sourceEventId }
  return snapshot
}
async function verifyCleanupRun(client, scope, record, b, id) {
  const detail = await client.rpc('agents.getIssueThread', [record.issueId, id])
  check(detail.thread?.id === id && detail.thread.ownedByCurrentUser === true, 'run_scope_changed')
  const { run } = await client.json('/api/runs/' + id + '/evidence'), identity = run?.executionIdentity
  check(run?.id === id && run.issueId === record.issueId && run.botId === b.botId && identity?.version === 1
    && identity.requester === scope.ownerId && identity.outputOwner === scope.ownerId
    && identity.executionPrincipal === scope.ownerId && identity.botOwner === scope.ownerId && identity.botId === b.botId
    && identity.workspaceId === b.workspaceId, 'run_scope_changed')
}

export async function cleanup(client, scope, record, b, state, budget) {
  state.cleanup = true
  budget?.enterCleanup()
  const result = { status: 'passed', tasksRetained: true, pullRequestRetainedUntilAfter: true,
    branchRetainedUntilAfter: true, errors: [], machines: [] }
  const step = async (name, work) => { try { await work() } catch (error) { result.status = 'failed'; result.errors.push({ step: name, ...publicFailure(error) }) } }
  let coordinatorStopped = !record.submitted, discovered
  if (record.submitted) await step('coordinator', async () => {
    await client.rpc('coordinator.stopCoordinatorTurn', [b.botId])
    const chat = await client.rpc('coordinator.pollCoordinatorChat', [b.botId])
    check(chat.botId === b.botId && chat.working === false && !chat.streamRunId, 'cleanup_failed')
    coordinatorStopped = true
  })
  if (record.createAttempted && record.issueId && !record.taskAuthorized) await step('task_scope', async () => {
    const access = await readHistoryTaskAccess(client, scope, record.issueId, scope.ownerId)
    check(access.creator === scope.ownerId, 'run_scope_changed'); record.taskAuthorized = true
  })
  if (record.submitted && !record.dispatchSettled && record.issueId && coordinatorStopped) {
    await step('discovery', async () => { discovered = await discoverCleanupRuns(client, scope, record, b, state) })
    for (const id of state.discoveryRunIds ?? []) await step('discovery_run', async () => {
      await verifyCleanupRun(client, scope, record, b, id); state.runIds.add(id)
    })
    result.recoveredRunIds = [...state.runIds]
  }
  if (record.runId || discovered) await step('factory', async () => {
    const snapshot = discovered ?? await readFactory(client, scope, record, b, state)
    // A passed stage may still advance automatically. Only these two states
    // fence further work; cancellation preserves the durable publication row.
    if (!['cancelled', 'revoked'].includes(snapshot.task.status)) {
      state.cancelInput = { binding: { taskId: snapshot.task.id, revision: snapshot.task.revision }, eventId: record.submissionId,
        action: 'cancel', reason: '1782 owned publication baseline observed or failed; stop this exact request epoch and retain immutable history.' }
      const stopped = await client.json('/api/factory/tasks/' + snapshot.task.id, post(state.cancelInput))
      check(stopped.task?.id === snapshot.task.id && ['cancelled', 'revoked'].includes(stopped.task.status), 'cleanup_failed')
    }
  })
  check(state.runIds.size <= 10, 'run_scope_changed')
  await Promise.allSettled([...state.runIds].map(id => step('run_machine', async () => {
    // Cleanup authority is the exact normally readable own Run and frozen
    // Factory epoch, even if execution used an unexpected model and failed.
    const stop = async signal => {
      const detail = await client.rpc('agents.getIssueThread', [record.issueId, id], { signal })
      check(detail.thread?.id === id && detail.thread.ownedByCurrentUser === true, 'run_scope_changed')
      const ended = await client.json('/api/threads/' + id + '/machine', { ...post({ action: 'end' }), ...(signal ? { signal } : {}) }, 120000)
      check(ended.runId === id && ended.state === 'ended', 'cleanup_failed')
      const machine = await client.rpc('agents.getThreadMachine', [record.issueId, id], { signal })
      check(machine.kind === 'cloud' && machine.state === 'ended' && machine.cloud === null, 'cleanup_failed')
      result.machines.push({ runId: id, acknowledgedEnded: true, machineReadbackEnded: true })
    }
    if (budget) await budget.run('cleanup', 120000, stop); else await stop()
  })))
  if (record.submitted && !record.dispatchSettled || record.createAttempted && !record.issueId) {
    result.status = 'failed'; result.errors.push({ step: 'uncertain_mutation', code: record.issueId ? 'dispatch_unknown' : 'task_create_uncertain' })
  }
  return result
}

export async function capture(client, env, b, state, text, { budget, pin, observe = watchRun, now = Date.now, WebSocketImpl = globalThis.WebSocket } = {}) {
  checkBinding(b); check(budget && CLIENT_BUDGETS.get(client) === budget && typeof pin === 'function', 'binding_refused')
  const doc = fixtureDocument(b, text, env.GITHUB_SHA), { email, password } = smokeAcceptanceAccount(env)
  const report = { version: 1, batch: 1782, issue: 1687, mode: 'owned_publication_fixture', status: 'failed',
    mainSha: b.applicationSha, opsSource: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: 1,
    startedAt: new Date(now()).toISOString(), fixtureSha256: FIXTURE_SHA256, fixturePath: FIXTURE_PATH,
    preflight: { runId: b.preflightRunId, opsSource: b.preflightOpsSource, evidenceSha256: b.preflightEvidenceSha256 }, budget: budget.summary(),
    record: { fingerprint: doc.fingerprint, submissionId: doc.submissionId, harness: MODEL.harness, profileId: b.profileId, placement: { kind: 'cloud' } },
    limitations: ['new_pre_migration_fixture_not_preexisting_history', 'not_a_before_snapshot',
      'normal_server_publication_requires_independent_GitHub_and_exact_readonly_APP_confirmation',
      'Task_PR_branch_retained_until_same_ID_after_comparison'], cleanup: { signedOut: false } }
  const record = report.record; let signedIn = false, scope
  try {
    budget.remaining('work'); report.before = await pin(budget); budget.remaining('work'); signedIn = true
    check((await client.request('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))).ok, 'account_refused')
    scope = await authorize(client, email, b); scope.botId = b.botId; scope.evidence = { teamWorkspaceHash: hash(b.workspaceId).slice(0,16) }
    const profile = await pinResources(client, scope, b)
    report.oldRunWitness = await verifyOldRun(client, scope, b)
    check(Date.parse(b.oldRunWitness.observedAt) <= now(), 'old_run_changed')
    await pin(budget); budget.remaining('work')
    state.taskInput = { title: doc.title, status: 'todo', priority: 'normal', content: doc.content }
    record.createAttempted = true
    const { issue } = await client.rpc('issues.saveIssue', [state.taskInput])
    // A normal response's own UUID survives a later DTO validation failure.
    // Never resend an uncertain create; subsequent authorization is still a
    // normal same-Workspace detail read, not trust in the acknowledgement.
    if (UUID.test(issue?.id) && issue.userId === scope.ownerId) state.issueId = record.issueId = issue.id
    check(UUID.test(issue?.id) && issue.userId === scope.ownerId && issue.workspaceId === b.workspaceId
      && positive(issue.revision) && typeof issue.identifier === 'string' && issue.identifier.length > 0, 'task_invalid')
    record.identifierSha256 = hash(issue.identifier)
    const createdAt = issue.createdAt instanceof Date ? issue.createdAt.toISOString() : issue.createdAt
    check(iso(createdAt) && Date.parse(createdAt) > Date.parse(b.oldRunWitness.observedAt), 'task_invalid')
    record.taskCreatedAt = createdAt
    const created = await readHistoryTaskAccess(client, scope, record.issueId, scope.ownerId)
    check(created.mode === 'live' && created.creator === scope.ownerId, 'task_invalid')
    record.taskAuthorized = true
    await pin(budget); await pinResources(client, scope, b); budget.remaining('work')
    await budget.run('work', 120000, signal => dispatch(client, record, b, state, budget.remaining('work', 120000), signal))
    await subscriptionProof(client, record, scope, profile)
    const watchLease = budget.lease('work', 20 * 60000); state.workSignal = watchLease.signal
    try { await observe(client, record, budget.remaining('work', 20 * 60000), WebSocketImpl, now, null, { allowTerminal: true, signal: watchLease.signal,
      matches: e => e.kind === 'factory_issue' && e.id === record.issueId || e.kind === 'factory_task' && e.id === state.factoryId,
      observe: async (detail, hooks) => {
        budget.remaining('work'); hooks.checkActive()
        check(detail.thread?.id === record.runId && detail.thread.ownedByCurrentUser === true, 'run_scope_changed')
        const snapshot = await readFactory(client, scope, record, b, state); hooks.checkActive(); hooks.watchScope(b.workspaceId)
        record.runs = []
        for (const id of state.runIds) { hooks.watchRun(id); record.runs.push(await verifyRun(client, scope, id, record, b)); hooks.checkActive() }
        const primary = record.runs.find(r => r.id === record.runId)
        check(!TERMINAL.has(primary.status) || primary.status === 'succeeded', 'run_failed')
        if (primary.status !== 'succeeded') return false
        const flow = await client.json('/api/factory/tasks/' + state.factoryId + '/flow')
        if (!publicationReceipt(snapshot, flow, record)) { hooks.checkActive(); return false }
        const activity = await client.json('/api/factory/tasks/' + state.factoryId + '/activity')
        const receipt = publishedActivityReceipt(snapshot, flow, activity, record, b); hooks.checkActive()
        if (!receipt) return false
        record.delivery = receipt; return true
      } }) } catch (error) { if (watchLease.signal.aborted) throw budgetError(); throw error }
    finally { state.workSignal = null; watchLease.dispose() }
    budget.remaining('work')
    check(record.delivery?.taskId === record.issueId && record.delivery.runId === record.runId
      && record.delivery.factoryId === state.factoryId && record.factoryBinding?.id === state.factoryId
      && SHA.test(record.delivery.commitSha ?? ''), 'publication_invalid')
    const afterScope = await authorize(client, email, b)
    check(afterScope.ownerId === scope.ownerId && afterScope.adminId === scope.adminId, 'workspace_refused')
    const access = await readHistoryTaskAccess(client, scope, record.issueId, scope.ownerId)
    check(access.mode === 'live', 'task_invalid')
    report.after = await pin(budget); budget.remaining('work'); report.status = 'publication_observed_pending_independent_verification'
  } catch (error) { report.failure = publicFailure(budget.signal('work').aborted ? budgetError() : error) }
  finally {
    try {
      if (scope) report.cleanup = { ...await cleanup(client, scope, record, b, state, budget), signedOut: false }
      else budget.enterCleanup()
    } catch (error) { report.cleanup = { ...report.cleanup, status: 'failed', errors: [{ step: 'cleanup', ...publicFailure(error) }] } }
    budget.enterSignout()
    if (signedIn) {
      try { check((await client.request('/api/auth/sign-out', post({}))).ok, 'signout_failed'); report.cleanup.signedOut = true }
      catch { report.failure ??= { code: 'signout_failed' }; report.status = 'failed' }
    }
    if (report.cleanup.status === 'failed') { report.status = 'failed'; report.failure ??= { code: 'cleanup_failed' } }
    client.clear(); budget.dispose(); report.completedAt = new Date(now()).toISOString()
  }
  return report
}

async function main(operation) {
  check(['check', 'capture'].includes(operation), 'source_refused')
  const env = process.env, git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 16384 }).trim()
  guardContext(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')), git('rev-parse', 'HEAD'),
    git('show', '-s', '--format=%P', 'HEAD').split(' '), git('status', '--porcelain', '--untracked-files=all') !== '')
  const text = await readFile(new URL('./publication-fixture-1782.md', import.meta.url), 'utf8')
  fixtureDocument(BINDING, text, env.GITHUB_SHA)
  const budget = createCaptureBudget(BINDING); let report
  try {
    await guardMain(env, BINDING, fetch, Date.now, 25 * 60000, budget)
    if (operation === 'check') { console.log(JSON.stringify({ sourceVerified: true, mode: 'owned_publication_fixture' })); return }
    const state = newState(), client = createFixtureClient(BINDING, state, budget)
    report = await capture(client, env, BINDING, state, text, { budget, pin: () => guardMain(env, BINDING, fetch, Date.now, 0, budget) })
  } finally { budget.dispose() }
  report.sourceSha256 = hash(await readFile(new URL(import.meta.url)))
  const output = resolve(env.RUNNER_TEMP, 'publication-fixture-1782'); await mkdir(output, { recursive: true, mode: 0o700 })
  const bytes = JSON.stringify(report, null, 2) + '\n'
  const receipt = { mode: report.mode, status: report.status, mainSha: report.mainSha, opsSource: report.opsSource,
    runId: report.runId, runAttempt: 1, evidenceSha256: hash(bytes), cleanup: report.cleanup,
    ...(report.failure ? { failure: report.failure } : {}) }
  await writeFile(resolve(output, 'fixture.json'), bytes, { mode: 0o600 })
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(receipt)); if (report.status !== 'publication_observed_pending_independent_verification') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(JSON.stringify(publicFailure(error))); process.exitCode = 1 })
}
