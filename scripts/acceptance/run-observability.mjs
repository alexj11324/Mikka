#!/usr/bin/env node
/**
 * Issue #1512, ordinary production account only. Default: read-only preflight
 * (apart from creating/closing its own login session). --execute submits one
 * small Factory deliverable on each required subscription, once per deployment.
 *
 * Node 24: node scripts/acceptance/run-observability.mjs [--execute [--prepare] [--browser-submit]]
 * Required env: ACME_DEMO_EMAIL, ACME_DEMO_PASSWORD, MIKKA_EXPECTED_DEPLOYMENT_SHA.
 * Optional: MIKKA_OBSERVABILITY_MODEL_CASE=all|claude|codex; timeout per model
 * MIKKA_OBSERVABILITY_TIMEOUT_MS (60_000..600_000, default 480_000).
 * Infisical credentials stay in the runner. Never enable fetch/HTTP debug output.
 * One execute/review (plus legacy verify) is allowed; observed excess stops.
 * No endpoint provides a hard dollar cap or synchronous native-attempt fence.
 * PostHog/APM ingestion and real browser replay require independent verification.
 */
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { decode, encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { liveInvalidation, liveReadiness } from '../../lib/live/events.ts'
import en from '../../messages/en.json' with { type: 'json' }
import zh from '../../messages/zh-CN.json' with { type: 'json' }
import { responseCookieJar } from './response-cookie-jar.mjs'

export const ORIGIN = 'https://app.aspectlylabs.com'
export const CASES = Object.freeze([
  Object.freeze({ id: 'claude', model: 'claude-haiku-5-5', harness: 'claude_code', provider: 'claude' }),
  Object.freeze({ id: 'codex', model: 'gpt-6-luna', harness: 'codex', provider: 'codex' }),
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const WORKFLOW = /^wrun_[A-Za-z0-9_-]{10,160}$/
const nativeStatuses = new Set(['queued', 'preparing', 'running', 'waiting_input', 'paused', 'finishing', 'succeeded', 'failed', 'stopped', 'cancelled'])
const nativeTerminal = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const taskStages = new Set(['clarify', 'spec', 'execute', 'review', 'verify', 'approval', 'publish', 'monitor'])
const taskStatuses = new Set(['pending', 'running', 'waiting', 'passed', 'failed', 'blocked', 'cancelled', 'revoked', 'completed', 'succeeded'])
const errorCodes = new Set([
  'configuration_required', 'origin_rejected', 'build_mismatch', 'account_required', 'sign_in_failed', 'session_identity',
  'http_refused', 'request_failed', 'response_invalid', 'workspace_missing', 'workspace_busy', 'task_inventory_truncated',
  'coordinator_disabled', 'coordinator_busy', 'model_not_restorable', 'model_changed', 'model_selection',
  'paid_fallback_enabled', 'profiles_active', 'profile_changed', 'profile_scope', 'previous_fixture',
  'source_missing', 'source_ambiguous', 'source_blocked', 'cloud_unavailable', 'live_unavailable', 'live_disconnected',
  'task_timeout', 'interrupted', 'submission_refused', 'foreign_activity', 'task_scope', 'fixture_ambiguous',
  'run_scope', 'run_model', 'run_identity', 'run_profile', 'run_failed', 'budget_exceeded', 'task_blocked',
  'artifact_missing', 'artifact_content', 'cleanup_incomplete', 'acceptance_failed',
  'owner_busy', 'owner_inventory_incomplete', 'owner_inventory_changed', 'owner_inventory_timeout',
  'preparation_conflict', 'preparation_restore_failed', 'task_inventory_changed',
  'task_checks_missing', 'task_acceptance', 'recovery_metadata_invalid', 'recovery_checkpoint_failed',
])
const serverCodes = new Set(['authRequired', 'modelUnavailable', 'modelChanged', 'factoryStale', 'factoryStopped', 'runChainEnded',
  'agentProfileNotFound', 'agentProfileRequestConflict', 'agentProfileVersionConflict', 'subscriptionConflict',
  'coordinatorUnavailable', 'issueToolsDisabled', 'submissionConflict', 'validationGeneric'])
export class AcceptanceError extends Error {
  constructor(code, options = {}) { super(errorCodes.has(code) ? code : 'acceptance_failed', options); this.code = this.message }
}
const check = (condition, code) => { if (!condition) throw new AcceptanceError(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const uuid = value => typeof value === 'string' && UUID.test(value)
const settledTask = (task, candidates = []) => ['cancelled', 'revoked', 'completed', 'succeeded'].includes(task.status)
  || task.status === 'passed' && (task.stage === 'monitor'
    || task.stage === 'approval' && (Object.hasOwn(task, 'candidateSha') ? task.candidateSha : candidates.find(value => value.id === task.candidateId)?.sha) === null)
const sameModel = (a, b) => a?.id === b?.id && a?.kind === b?.kind && a?.modelId === b?.modelId && a?.provider === b?.provider && a?.chosen === b?.chosen && !a?.fallback
const sourceKey = value => JSON.stringify([value?.harness, value?.model, value?.source?.kind, value?.source?.connectionId])
const profilePath = (workspaceId, id = '') => '/api/factory/agent-profiles' + (id ? '/' + id : '') + '?workspaceId=' + workspaceId
const profileDefinition = value => Object.fromEntries(['name', 'description', 'roles', 'enabled', 'harness', 'model', 'effort', 'instructions', 'skills']
  .filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]))


/** Recovery metadata only: never persist menu labels, quotas or private Profile definitions. */
function recoveryModel(value) {
  const { id, kind, modelId, provider, chosen } = value ?? {}
  const model = typeof modelId === 'string' && (modelId === '' || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(modelId))
  const apiKey = typeof id === 'string' && /^apikey:[0-9a-f-]{36}:/i.test(id)
    && uuid(id.slice(7, 43)) && id.slice(44) === modelId
  check(['hosted', 'subscription', 'apiKey', 'shared'].includes(kind) && typeof chosen === 'boolean'
    && model && typeof provider === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(provider)
    && (kind === 'apiKey' || kind === 'shared' ? apiKey && modelId !== '' : uuid(id)), 'recovery_metadata_invalid')
  return { id, kind, modelId, provider, chosen }
}

/** Fixed runner-local file; replace the complete 0600 snapshot, never append private state. */
export async function writeRecoveryJournal(journal) {
  const directory = 'production-run-observability-report', temporary = directory + '/.recovery.json.tmp'
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try { await file.writeFile(JSON.stringify(journal, null, 2) + '\n'); await file.sync() }
    finally { await file.close() }
    await rename(temporary, directory + '/recovery.json')
    const parent = await open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
  } finally {
    if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

async function selectOwnPersonalWorkspace(read, rpc, ownerId) {
  const current = await read('/api/workspace')
  const choices = Array.isArray(current.choices) ? current.choices.filter(value => value.kind === 'personal') : []
  check(current.currentUserId === ownerId && choices.length === 1 && uuid(choices[0].id), 'workspace_missing')
  const workspaceId = choices[0].id
  const owned = value => value.workspace?.id === workspaceId && value.workspace.kind === 'personal'
    && value.currentUserId === ownerId && value.role === 'admin' && Array.isArray(value.members) && value.members.length === 1
    && value.members[0]?.userId === ownerId && value.members[0].role === 'admin' && value.members[0].status === 'active'
  if (current.workspace?.id === workspaceId) {
    check(owned(current), 'workspace_missing')
    return { workspaceId, workspaceSelection: 'current_personal' }
  }
  check(uuid(current.workspace?.id) && current.workspace.kind === 'team', 'workspace_missing')
  check(owned(await read('/api/workspace?workspace=' + workspaceId)), 'workspace_missing')
  // Use the normal switch action on this new login session. An explicit GET
  // alone does not change the implicit workspace used by Coordinator routes.
  const changed = await rpc('workspace.switchWorkspace', [{ workspaceId, accountId: ownerId }])
  check(changed.ok === true && changed.data?.workspaceId === workspaceId, 'workspace_missing')
  check(owned(await read('/api/workspace')), 'workspace_missing')
  return { workspaceId, workspaceSelection: 'switched_personal' }
}

/** The relation picker is the existing uncapped, authorized cursor API. Follow
 * server cursors exactly; a bounded page scan is not periodic data polling. */
export async function issueInventory(read, workspaceId) {
  const items = new Map(), cursors = new Set()
  let cursor = null, first
  const path = '/api/issues/search?workspaceId=' + workspaceId + '&limit=50&q='
  for (let page = 0; page < 100; page++) {
    const found = await read(path + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    check(Array.isArray(found?.items) && found.items.length <= 50 && found.truncated === false
      && (found.nextCursor === null || typeof found.nextCursor === 'string' && found.nextCursor.length <= 1024), 'response_invalid')
    const signature = value => JSON.stringify([value.nextCursor, value.items.map(item => [item.id, item.revision, item.updatedAt])])
    if (page === 0) first = signature(found)
    for (const item of found.items) {
      check(uuid(item.id) && !items.has(item.id), 'task_inventory_changed')
      items.set(item.id, { id: item.id })
    }
    if (found.nextCursor === null) {
      // A move during the scan must not silently skip an older task. One head
      // check validates this finite scan; concurrent activity fails closed.
      if (page > 0) {
        const head = await read(path)
        check(Array.isArray(head?.items) && head.truncated === false && signature(head) === first, 'task_inventory_changed')
      }
      return [...items.values()]
    }
    check(found.items.length > 0 && !cursors.has(found.nextCursor), 'task_inventory_changed')
    cursors.add(found.nextCursor); cursor = found.nextCursor
  }
  throw new AcceptanceError('task_inventory_truncated')
}

export function publicFailure(error) {
  return { status: 'blocked', code: error instanceof AcceptanceError ? error.code : 'acceptance_failed',
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}),
    ...(serverCodes.has(error?.serverCode) ? { serverCode: error.serverCode } : {}) }
}
export function fixtureIdentity(revision, item) {
  check(SHA.test(revision) && CASES.includes(item), 'configuration_required')
  const value = hash('mikka-observability:1512:' + revision + ':' + item.id)
  return { marker: 'm1512-' + value.slice(0, 16), profileId: value.slice(0, 8) + '-' + value.slice(8, 12) + '-4' + value.slice(13, 16) + '-8' + value.slice(17, 20) + '-' + value.slice(20, 32) }
}
/** Code-generated, non-private acceptance input; never reused for user content. */
export function fixtureTask(revision, item) {
  const fixture = fixtureIdentity(revision, item), title = fixture.marker + '.txt'
  const content = 'mikka-observability:' + fixture.marker + '\nstatus=ready\n'
  const input = '请创建且只创建一个 Factory 任务，标题必须为 ' + fixture.marker + '。在所选云端和固定 Agent Profile 上完成一次很小的真实交付：创建名称为 ' + title
    + ' 的纯文本 Artifact，UTF-8 内容必须精确等于这个 JSON 字符串解码后的字节（包括末尾换行）：' + JSON.stringify(content)
    + '。实际读取文件验证后，作为无仓库 deliverable 候选通过正常 Artifact 工具提交，交给当前 Factory 流程的独立 review；只有旧版流程需要独立 verify。等待正常交付验收，不合并或发布仓库。使用选中的 Profile，所有阶段只允许我的官方订阅 ' + item.model
    + '，失败就停止；不要切换账号、API Key、模型，或重试/修复/创建第二个任务。不要外部发消息、推送代码或改别的资源。完成后只回复此任务、线程和 Artifact 链接。'
  return { ...fixture, title, content, input }
}
export function browserSubmissionText(input, locale) {
  check(['en', 'zh-CN'].includes(locale), 'configuration_required')
  const text = (locale === 'en' ? en : zh).Shell.newTaskDialog
  const context = text.contextDevice.replace('{device}', () => text.cloud)
  return text.promptWithContext.replace('{context}', () => context).replace('{text}', () => input)
}
// The runner log must expose readiness before waiting for the real UI. Only
// locally generated fixture text and explicitly selected safe IDs enter here.
const emitBrowserReady = value => new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve())
})
/** A sole fixed Profile pins Factory's independent checks; its native receipt
 * proves that selection. Optional preparation happens outside this gate. */
export function preflightCase(item, { ownerId, menu, order, connections, keys, profiles }) {
  check(Array.isArray(menu?.groups) && Array.isArray(order?.candidates) && Array.isArray(order?.entries)
    && Array.isArray(connections?.connections) && Array.isArray(profiles?.profiles), 'response_invalid')
  check(keys?.apiKeyAfterQuota === false, 'paid_fallback_enabled')
  check(profiles.profiles.every(profile => profile.enabled === false || profile.archivedAt), 'profiles_active')
  const current = menu.current
  const restoreImplicit = menu.preferenceState === 'absent'
  check(restoreImplicit ? current?.chosen === false : current?.chosen === true && current.available === true && !current.fallback && typeof current.id === 'string'
    && menu.groups.some(group => group.options?.some(option => option.id === current.id)), 'model_not_restorable')
  const options = menu.groups.filter(group => group.kind === 'subscription').flatMap(group => group.options ?? [])
    .filter(option => option.modelId === item.model && option.provider === item.provider && uuid(option.id))
  check(options.length === 1, options.length ? 'source_ambiguous' : 'source_missing')
  const connected = new Set(connections.connections.filter(value => value.provider === item.provider && value.state === 'connected' && !value.paused).map(value => value.id))
  const choices = order.candidates.filter(value => value.model === item.model && value.harness === item.harness
    && value.source?.kind === 'subscription' && connected.has(value.source.connectionId) && value.credentialOwnerId === ownerId)
  check(choices.length > 0, 'source_missing')
  check(new Set(choices.map(sourceKey)).size === 1, 'source_ambiguous')
  const source = choices[0], row = order.entries.find(entry => sourceKey(entry) === sourceKey(source))
  check(!row?.block, 'source_blocked')
  check(order.location === 'cloud' && order.cloudReady === true && (!row || order.cloudModels?.[row.id] === 'ready'), 'cloud_unavailable')
  const offered = profiles.catalog?.models?.find(value => sourceKey(value) === sourceKey(source))
  check(offered?.available === true, 'source_blocked')
  return { option: options[0], source, ...(restoreImplicit ? { restoreImplicit: true } : {}) }
}
export function runProof(found, { item, ownerId, workspaceId, botId, issueId, profileId }) {
  const run = found?.run, identity = run?.executionIdentity
  check(uuid(run?.id) && run.botId === botId && run.issueId === issueId && nativeStatuses.has(run.status), 'run_scope')
  check(run.model === item.model && run.harness === item.harness && run.credentialType === 'subscription'
    && run.subscriptionRoute === (item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli'), 'run_model')
  check(run.agentProfile?.profileId === profileId && run.agentProfile.version === 1, 'run_profile')
  check(identity?.version === 1 && identity.requester === ownerId && identity.executionPrincipal === ownerId
    && identity.outputOwner === ownerId && identity.botOwner === ownerId && identity.botId === botId
    && identity.workspaceId === workspaceId && identity.personalResourcePolicy === 'requester_only', 'run_identity')
  const payer = identity.billingAccount?.model, runtime = identity.billingAccount?.runtime
  check(payer?.kind === 'subscription' && payer.ownerId === ownerId && identity.resourceBindings?.some(value =>
    value.kind === 'subscription' && value.id === payer.resourceId && value.ownerId === ownerId && value.access === 'owner')
    && runtime?.kind === 'e2b' && runtime.ownerId === ownerId, 'run_identity')
  return { runId: run.id, status: run.status, harness: item.harness, model: item.model, subscriptionRoute: run.subscriptionRoute,
    profileId, ownSubscription: true, ownCloudRuntime: true }
}
export function assertAttemptBudget(attempts, flowVersion = 1) {
  const runs = attempts.filter(attempt => uuid(attempt.runId))
  const stages = flowVersion === 2 ? ['execute', 'review'] : ['execute', 'review', 'verify']
  check(runs.length <= stages.length && new Set(runs.map(attempt => attempt.runId)).size === runs.length
    && runs.every(attempt => stages.includes(attempt.stage))
    && new Set(runs.map(attempt => attempt.stage)).size === runs.length, 'budget_exceeded')
}
/** The host freezes flowVersion. v2 has one independent review; historical
 * tasks retain review + verify. Approval never substitutes for either check. */
export function factoryReviewProof(state, proofs) {
  const task = state.task, flowVersion = task.route?.flowVersion === 2 ? 2 : 1
  const stages = flowVersion === 2 ? ['execute', 'review'] : ['execute', 'review', 'verify']
  assertAttemptBudget(state.attempts ?? [], flowVersion)
  check(!['failed', 'blocked', 'cancelled', 'revoked'].includes(task.status), 'task_blocked')
  if (task.stage !== 'approval') return null
  const candidate = state.candidates?.find(value => value.id === task.candidateId)
  check(candidate && uuid(candidate.id) && uuid(candidate.runId) && uuid(task.sourceEventId), 'task_checks_missing')
  const attempts = stages.map(stage => (state.attempts ?? []).find(value => value.stage === stage && value.candidateId === candidate.id))
  check(attempts.every(value => value && uuid(value.runId) && value.status === 'passed' && value.output?.requestEpoch === task.sourceEventId
    && proofs.get(value.runId)?.status === 'succeeded') && attempts[0].runId === candidate.runId, 'task_checks_missing')
  // This acceptance is only for its tiny file, never a repository publication.
  check(candidate.kind === 'deliverable' && candidate.sha === null && candidate.repository === 'none', 'task_scope')
  return { flowVersion, candidate, checks: attempts.slice(1) }
}

/** No business polling. One authenticated push socket; only post-commit keys
 * wake the reader. Timers bound the run and keep this socket alive. A broken
 * live channel fails the attempt instead of switching to periodic HTTP reads. */
export async function openLive(read, workspaceId, { now = Date.now, socketFactory = (url, protocol) => new WebSocket(url, protocol) } = {}) {
  let socket, revision = 0, fault, closed = false, heartbeat, expiry
  const waiters = new Set()
  const wake = () => { for (const callback of waiters) callback() }
  const fail = () => { if (!closed) { fault = new AcceptanceError('live_disconnected'); wake() } }
  const close = () => { closed = true; clearTimeout(heartbeat); clearTimeout(expiry); socket?.close(); wake() }
  const ping = () => {
    if (closed || fault) return
    try { socket.send('ping') } catch { fail(); return }
    heartbeat = setTimeout(ping, 25_000)
  }
  async function connect() {
    const ticket = await read('/api/live/ticket?workspace=' + workspaceId)
    if (closed) return
    let url
    try { url = new URL(ticket?.url) } catch (cause) { throw new AcceptanceError('live_unavailable', { cause }) }
    check(url.protocol === 'wss:' && !url.username && !url.password && !url.search && !url.hash
      && /^\/v1\/live\/[a-f0-9]{64}\/socket$/.test(url.pathname)
      && typeof ticket.protocol === 'string' && ticket.protocol.length <= 2048 && Number.isFinite(ticket.expiresAt) && ticket.expiresAt > now() + 30_000, 'live_unavailable')
    url.searchParams.set('revisions', '1')
    const previous = socket
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new AcceptanceError('live_unavailable')), 15_000)
      let next
      try { next = socketFactory(url.href, ticket.protocol) } catch (cause) { clearTimeout(timeout); reject(new AcceptanceError('live_unavailable', { cause })); return }
      socket = next
      if (previous) { previous.onclose = previous.onerror = previous.onmessage = null; previous.close() }
      next.onmessage = message => {
        if (message.data === 'pong') return
        if (typeof message.data !== 'string' || message.data.length > 2048) return
        let value
        try { value = JSON.parse(message.data) } catch { return }
        const readiness = liveReadiness(value)
        if (readiness) {
          if (['bot_chat', 'run', 'factory_task', 'factory_issue'].every(kind => readiness.kinds.includes(kind))) { clearTimeout(timeout); resolve() }
          else { clearTimeout(timeout); reject(new AcceptanceError('live_unavailable')) }
        } else if (liveInvalidation(value, true)) { revision++; wake() }
      }
      next.onerror = next.onclose = () => { clearTimeout(timeout); fail(); reject(new AcceptanceError('live_disconnected')) }
    })
    // Ticket renewal is the live channel's normal five-minute capability
    // lifecycle. Catch up once after reconnect, never periodically reread data.
    revision++; wake()
    expiry = setTimeout(() => { void connect().catch(fail) }, Math.max(1, ticket.expiresAt - now() - 20_000))
  }
  try { await connect() } catch (error) { close(); throw error }
  heartbeat = setTimeout(ping, 25_000)
  return {
    get revision() { return revision },
    wait(after, deadline, signal) {
      if (signal?.aborted) return Promise.reject(new AcceptanceError('interrupted'))
      if (fault || closed) return Promise.reject(fault ?? new AcceptanceError('live_disconnected'))
      if (revision > after) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const finish = error => { clearTimeout(timer); waiters.delete(changed); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve() }
        const changed = () => { if (fault || closed) finish(fault ?? new AcceptanceError('live_disconnected')); else if (revision > after) finish() }
        const abort = () => finish(new AcceptanceError('interrupted'))
        const timer = setTimeout(() => finish(new AcceptanceError('task_timeout')), Math.max(1, deadline - now()))
        waiters.add(changed); signal?.addEventListener('abort', abort, { once: true }); changed()
      })
    },
    close,
  }
}

export async function runObservabilityAcceptance({ env = process.env, execute = false, prepare = false, browserSubmit = false,
  onBrowserReady = emitBrowserReady, onRecoveryCheckpoint = async () => {}, fetchImpl = fetch, now = Date.now, openLiveImpl = openLive, signal } = {}) {
  check((!prepare && !browserSubmit || execute) && typeof onBrowserReady === 'function' && typeof onRecoveryCheckpoint === 'function', 'configuration_required')
  const revision = env.MIKKA_EXPECTED_DEPLOYMENT_SHA
  const timeoutMs = Number(env.MIKKA_OBSERVABILITY_TIMEOUT_MS ?? 480_000)
  const modelCase = env.MIKKA_OBSERVABILITY_MODEL_CASE ?? 'all'
  check(['all', 'claude', 'codex'].includes(modelCase), 'configuration_required')
  check(!browserSubmit || modelCase !== 'all', 'configuration_required')
  const cases = CASES.filter(item => modelCase === 'all' || item.id === modelCase)
  check(SHA.test(revision ?? '') && Number.isSafeInteger(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 600_000, 'configuration_required')
  check(!env.MIKKA_ACCEPTANCE_BASE_URL || env.MIKKA_ACCEPTANCE_BASE_URL === ORIGIN + '/mikka', 'origin_rejected')
  const report = { version: 1, issue: 1512, revision, mode: execute ? 'execute' : 'preflight', status: 'running',
    startedAt: new Date(now()).toISOString(), browserReplayVerified: false, posthogIngestionVerified: false,
    budget: { submissionsPerModel: 1, nativeRunsByFlowVersion: { 1: 3, 2: 2 }, enforcement: 'stop_on_first_observed_excess', timeoutMs, paidResubmissions: 0, hardDollarCap: false },
    modelCase, submissionSource: browserSubmit ? 'browser' : 'api', cases: [], sessionClosed: false,
    preparation: { requested: prepare, profilesDisabled: 0, profilesRestored: 0, fallbackChanged: false, restoration: 'not_needed' } }
  const cookies = responseCookieJar(now)
  let ownerId, workspaceId, botId, closeSession = false
  // Full definitions never leave this closure or appear in the public report.
  const preparation = { profiles: [], fallback: null }
  const recovery = report.recovery = { version: 1, revision, scope: null, sequence: 0, checkpointFailures: 0,
    preparation: { profiles: [], fallback: null }, cases: [] }
  async function checkpoint(cleanup = false) {
    // A failed journal blocks new work, but cannot prevent already-required recovery.
    if (!cleanup && recovery.checkpointFailures) throw new AcceptanceError('recovery_checkpoint_failed')
    recovery.sequence++
    try { await onRecoveryCheckpoint(structuredClone(recovery)) }
    catch (cause) {
      recovery.checkpointFailures++
      if (!cleanup) throw new AcceptanceError('recovery_checkpoint_failed', { cause })
    }
  }
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', headers: extra, cleanup = false, deadline } = {}) {
    check(path.startsWith('/api/') || path.startsWith('/mikka/api/artifacts/'), 'origin_rejected')
    const url = new URL(path.startsWith('/mikka/') ? path : '/mikka' + path, ORIGIN)
    check(url.origin === ORIGIN && !url.username && !url.password && !url.hash, 'origin_rejected')
    if (!cleanup && signal?.aborted) throw new AcceptanceError('interrupted')
    const headers = new Headers({ origin: ORIGIN, 'cache-control': 'no-store', accept: 'application/json', ...extra })
    if (url.pathname.startsWith('/mikka/api/factory/')) {
      // Selection is routing, never authority: the ordinary endpoint still
      // checks the fresh session, membership, Origin and exact business target.
      check(uuid(workspaceId) && (!headers.has('x-mikka-workspace-id') || headers.get('x-mikka-workspace-id') === workspaceId)
        && url.searchParams.getAll('workspaceId').every(value => value === workspaceId)
        && (body?.workspaceId === undefined || body.workspaceId === workspaceId), 'workspace_missing')
      headers.set('x-mikka-workspace-id', workspaceId)
    }
    const remaining = deadline === undefined ? 30_000 : Math.min(30_000, deadline - now())
    check(Number.isSafeInteger(remaining) && remaining > 0, 'owner_inventory_timeout')
    const cookie = cookies.header(url); if (cookie) headers.set('cookie', cookie)
    if (body !== undefined) headers.set('content-type', 'application/json')
    let response
    try {
      response = await fetchImpl(url, { method, headers, redirect: 'error',
        signal: !cleanup && signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (cause) { throw new AcceptanceError(!cleanup && signal?.aborted ? 'interrupted' : 'request_failed', { cause }) }
    cookies.receive(url, response.headers)
    return response
  }
  async function read(path, options = {}) {
    const response = await request(path, options)
    const value = await response.json().catch(() => null)
    if (options.missing && response.status === 404 && value?.error === 'agentProfileNotFound') return null
    if (!response.ok || value?.error) {
      const error = new AcceptanceError('http_refused')
      error.httpStatus = response.status; error.serverCode = typeof value?.error === 'string' ? value.error : value?.error?.code
      throw error
    }
    check(value !== null, 'response_invalid')
    return value
  }
  async function rpc(action, args, options = {}) {
    check(['coordinator.sendCoordinatorMessage', 'issues.getIssue', 'agents.getIssueThread', 'task-runs.pollThreads',
      'task-runs.pollTaskRuns', 'model-api-keys.updateApiKeyAfterQuota', 'workspace.switchWorkspace'].includes(action), 'configuration_required')
    const value = await read('/api/rpc', { ...options, body: { version: DESKTOP_RPC_VERSION, action, args: encode(args) },
      headers: { 'x-mikka-rpc': '1', ...options.headers } })
    check(value.ok === true, 'response_invalid')
    let result
    try { result = decode(value.result) } catch (cause) { throw new AcceptanceError('response_invalid', { cause }) }
    check(result && !result.error, 'submission_refused')
    return result
  }
  const pin = async () => check((await read('/api/version')).build === revision, 'build_mismatch')
  const profileRead = (id = '', options = {}) => read(profilePath(workspaceId, id), options)
  const menuRead = ({ inspectPreference = false, ...options } = {}) => read('/api/mobile/model?bot=' + botId + (inspectPreference ? '&choiceState=1' : ''), options)
  async function quiet() {
    const [bots, threads, tasks, chat] = await Promise.all([
      read('/api/settings/workspace-bots'), read('/api/mobile/threads'), issueInventory(read, workspaceId), read('/api/coordinator/messages'),
    ])
    check(Array.isArray(bots?.bots) && Array.isArray(threads?.threads) && Array.isArray(chat?.items), 'response_invalid')
    check(bots.bots.every(bot => bot.status === 'idle' && bot.runningThreads === 0)
      && threads.threads.every(thread => ['failed', 'done', 'stopped'].includes(thread.status)), 'workspace_busy')
    for (let index = 0; index < tasks.length; index += 10) {
      await Promise.all(tasks.slice(index, index + 10).map(async issue => {
        const ledger = await read('/api/factory/tasks?issueId=' + issue.id)
        check(Array.isArray(ledger.tasks), 'workspace_busy')
        for (const task of ledger.tasks) {
          if (task && settledTask(task)) continue
          check(uuid(task?.id) && task.issueId === issue.id && Number.isSafeInteger(task.revision) && task.revision >= 0
            && taskStages.has(task.stage) && taskStatuses.has(task.status)
            && (task.attemptId === null || uuid(task.attemptId)) && (task.candidateId === null || uuid(task.candidateId)), 'workspace_busy')
          // Issue search is visibility-scoped. Only the authenticated task detail
          // binds its persisted Bot workspace; the list's live scope is the issue's.
          const detail = await read('/api/factory/tasks/' + task.id)
          check(detail.task?.userId === ownerId
            && ['id', 'issueId', 'revision', 'stage', 'status', 'attemptId', 'candidateId'].every(key => detail.task[key] === task[key])
            && uuid(detail.liveWorkspaceId) && detail.liveWorkspaceId.toLowerCase() !== workspaceId.toLowerCase(), 'workspace_busy')
        }
      }))
    }
    check(chat.botId === botId && chat.enabled === true, 'coordinator_disabled')
    check(chat.working === false && !chat.streamRunId && !chat.items.some(item => item.pending), 'coordinator_busy')
    return { chat, threads: new Set(threads.threads.map(thread => thread.id)), issues: new Set(tasks.map(task => task.id)) }
  }
  async function inventory() {
    const [menu, order, connections, keys, profiles] = await Promise.all([
      menuRead({ inspectPreference: true }), read('/api/settings/model-order?workspace=' + workspaceId), read('/api/subscriptions?workspace=' + workspaceId),
      read('/api/settings/api-keys?workspace=' + workspaceId), profileRead(),
    ])
    return { ownerId, menu, order, connections, keys, profiles }
  }
  async function ownerIdle(cleanup = false) {
    // P0 makes both readers workspace-scoped. Inventory is the ordinary,
    // unpaginated active-membership endpoint; never infer owner-wide idle from
    // the selected workspace alone. This finite scan is not an atomic fence.
    const started = now(), deadline = started + 30_000
    const withinTime = () => check(now() >= started && now() < deadline, 'owner_inventory_timeout')
    const complete = value => value && !Object.hasOwn(value, 'error')
      && (value.nextCursor === undefined || value.nextCursor === null)
      && (value.truncated === undefined || value.truncated === false)
      && (value.hasMore === undefined || value.hasMore === false)
    const inventory = async () => {
      withinTime()
      const value = await read('/api/workspace', { cleanup, deadline, headers: { 'x-mikka-workspace-id': workspaceId } })
      withinTime()
      check(complete(value) && value.currentUserId === ownerId && value.workspace?.id === workspaceId
        && value.workspace.kind === 'personal' && Array.isArray(value.choices) && value.choices.length > 0
        && value.choices.length <= 32, 'owner_inventory_incomplete')
      const choices = value.choices
      check(choices.every(choice => uuid(choice?.id) && ['personal', 'team'].includes(choice.kind))
        && new Set(choices.map(choice => choice.id.toLowerCase())).size === choices.length
        && choices.filter(choice => choice.kind === 'personal').length === 1
        && choices.some(choice => choice.kind === 'personal' && choice.id === workspaceId), 'owner_inventory_incomplete')
      return choices.map(({ id, kind }) => ({ id, kind })).sort((a, b) => a.id.localeCompare(b.id))
    }
    const before = await inventory()
    let checked = 0
    const expiries = []
    for (const workspace of before) {
      withinTime()
      const options = { cleanup, deadline, headers: { 'x-mikka-workspace-id': workspace.id } }
      const [threads, tasks] = await Promise.all([
        rpc('task-runs.pollThreads', [], options), rpc('task-runs.pollTaskRuns', [], options),
      ])
      withinTime()
      for (const [kind, result] of [['threads', threads], ['tasks', tasks]]) {
        check(complete(result) && Array.isArray(result.items) && result.items.length < 200
          && (result.delta === undefined || result.delta === false) && (result.unchanged === undefined || result.unchanged === false)
          && result.live?.ownerId === ownerId && result.live.workspaceId === workspace.id, 'owner_inventory_incomplete')
        const ids = result.items.map(value => kind === 'threads' ? value?.id : value?.runId)
        check(ids.every(uuid) && new Set(ids).size === ids.length
          && result.items.every(value => nativeStatuses.has(value?.status)), 'owner_inventory_incomplete')
        if (kind === 'threads') {
          check(typeof result.version === 'string' && /^[0-9a-f]{32}$/.test(result.version) && Array.isArray(result.positions)
            && result.positions.length === ids.length && new Set(result.positions.map(value => value?.id)).size === ids.length
            && result.positions.every(value => ids.includes(value?.id) && typeof value.version === 'string'
              && /^[0-9a-f]{32}$/.test(value.version)), 'owner_inventory_incomplete')
        }
        if (result.items.length) {
          const expiry = result.live.deadline
          check(typeof expiry?.at === 'string' && Number.isFinite(Date.parse(expiry.at))
            && Number.isFinite(expiry.afterMs) && expiry.afterMs > 0, 'owner_inventory_incomplete')
          expiries.push(Math.min(Date.parse(expiry.at), started + expiry.afterMs))
        }
        check(result.items.every(value => nativeTerminal.has(value.status)), 'owner_busy')
        checked += result.items.length
      }
    }
    const after = await inventory()
    check(isDeepStrictEqual(before, after), 'owner_inventory_changed')
    withinTime()
    // The existing readers cover only the last 30 days. If a visible row
    // expires during this scan, do not turn its disappearance into idle proof.
    check(expiries.every(expiry => expiry > now()), 'owner_inventory_incomplete')
    report.preparation.visibleRunRowsChecked = checked
    report.preparation.visibleRunWorkspacesChecked = before.length
    report.preparation.visibleRunWindowDays = 30
    report.preparation.workspaceScanAtomic = false
  }
  async function prepareSettings() {
    await quiet(); await ownerIdle()
    const state = await inventory()
    check(typeof state.keys.apiKeyAfterQuota === 'boolean', 'response_invalid')
    // Validate every other gate before changing settings. Actual case preflight
    // still reads the resulting server state with no exemptions.
    const gates = cases.map(item => {
      try { preflightCase(item, { ...state, keys: { ...state.keys, apiKeyAfterQuota: false },
        profiles: { ...state.profiles, profiles: state.profiles.profiles.map(value => ({ ...value, enabled: false })) } }); return null }
      catch (error) { return error }
    })
    // One unavailable subscription does not prevent the other selected case.
    // Each case still validates its own real state before making a model call.
    if (gates.every(Boolean)) throw gates[0]
    if (state.keys.apiKeyAfterQuota) {
      await ownerIdle()
      check((await read('/api/settings/api-keys?workspace=' + workspaceId)).apiKeyAfterQuota === true, 'preparation_conflict')
      const journal = recovery.preparation.fallback = { before: true, intended: false, write: 'intent', restored: false }
      await checkpoint()
      preparation.fallback = { before: true, acknowledged: false, journal }
      const changed = await rpc('model-api-keys.updateApiKeyAfterQuota', [false, workspaceId])
      check(changed.apiKeyAfterQuota === false, 'preparation_conflict')
      preparation.fallback.acknowledged = true; report.preparation.fallbackChanged = true
      journal.write = 'acknowledged'; await checkpoint()
    }
    for (const profile of state.profiles.profiles.filter(value => value.enabled && !value.archivedAt)) {
      check(uuid(profile.id) && Number.isSafeInteger(profile.version) && profile.version > 0, 'profile_scope')
      await ownerIdle()
      const current = (await profileRead(profile.id)).profile
      check(current?.version === profile.version && typeof profile.digest === 'string' && /^[0-9a-f]{64}$/.test(profile.digest)
        && current.digest === profile.digest && !current.archivedAt
        && isDeepStrictEqual(profileDefinition(current), profileDefinition(profile)), 'preparation_conflict')
      const journal = { id: profile.id, before: { version: profile.version, digest: profile.digest, enabled: profile.enabled },
        intendedEnabled: false, write: 'intent', written: null, restored: false }
      check(typeof journal.before.enabled === 'boolean', 'recovery_metadata_invalid')
      recovery.preparation.profiles.push(journal)
      await checkpoint()
      const entry = { id: profile.id, before: profileDefinition(profile), version: profile.version, written: null, rejected: false, journal }
      preparation.profiles.push(entry)
      let changed
      try { changed = (await read(profilePath(workspaceId, entry.id), { method: 'PATCH',
        body: { workspaceId, version: entry.version, profile: { ...entry.before, enabled: false } } })).profile }
      catch (error) {
        entry.rejected = [400, 401, 403, 404, 409, 422].includes(error.httpStatus)
        if (entry.rejected) journal.write = 'rejected'
        await checkpoint(true); throw error
      }
      check(changed?.id === entry.id && changed.version === entry.version + 1 && !changed.archivedAt && /^[0-9a-f]{64}$/.test(changed.digest)
        && isDeepStrictEqual(profileDefinition(changed), { ...entry.before, enabled: false }), 'preparation_conflict')
      entry.written = { version: changed.version, digest: changed.digest }
      report.preparation.profilesDisabled++
      journal.written = { ...entry.written }; journal.write = 'acknowledged'; await checkpoint()
    }
  }
  async function restoreSettings() {
    if (!preparation.fallback && !preparation.profiles.length) return
    const summary = report.preparation
    summary.restoration = 'complete'; summary.restoreFailures = 0
    const failed = error => { summary.restoration = 'incomplete'; summary.restoreFailures++; summary.restoreError = publicFailure(error) }
    try {
      check(report.cases.every(value => value.cleanup?.state === 'complete'), 'cleanup_incomplete')
      await ownerIdle(true)
    } catch (error) { failed(error); return }
    for (const entry of preparation.profiles.toReversed()) {
      if (entry.rejected) continue
      try {
        await ownerIdle(true)
        const current = (await profileRead(entry.id, { cleanup: true })).profile
        check(current && !current.archivedAt, 'preparation_conflict')
        if (!isDeepStrictEqual(profileDefinition(current), entry.before)) {
          // A lost PATCH response cannot prove which writer advanced this
          // profile. Preserve an unacknowledged/concurrent edit for review.
          check(entry.written && current.version === entry.written.version && current.digest === entry.written.digest
            && isDeepStrictEqual(profileDefinition(current), { ...entry.before, enabled: false }), 'preparation_conflict')
          await checkpoint(true)
          const restored = (await read(profilePath(workspaceId, entry.id), { method: 'PATCH', cleanup: true,
            body: { workspaceId, version: current.version, profile: entry.before } })).profile
          check(restored?.version === current.version + 1 && isDeepStrictEqual(profileDefinition(restored), entry.before), 'preparation_conflict')
        }
        summary.profilesRestored++
        entry.journal.restored = true
      } catch (error) { failed(error) }
      await checkpoint(true)
    }
    if (preparation.fallback) {
      try {
        await ownerIdle(true)
        const current = (await read('/api/settings/api-keys?workspace=' + workspaceId, { cleanup: true })).apiKeyAfterQuota
        if (current !== preparation.fallback.before) {
          // This existing boolean setting has no version/CAS API. Compare its
          // last acknowledged value immediately before restoring, never guess.
          check(preparation.fallback.acknowledged && current === false, 'preparation_conflict')
          await checkpoint(true)
          const restored = await rpc('model-api-keys.updateApiKeyAfterQuota', [preparation.fallback.before, workspaceId], { cleanup: true })
          check(restored.apiKeyAfterQuota === preparation.fallback.before, 'preparation_conflict')
        }
        summary.fallbackRestored = true
        preparation.fallback.journal.restored = true
      } catch (error) { failed(error) }
      await checkpoint(true)
    }
  }
  async function runCase(item) {
    const result = { case: item.id, model: item.model, status: 'running', cleanup: { state: 'not_created' } }
    const fixture = fixtureTask(revision, item)
    const started = now()
    let baseline, previousModel, selectedModel, temporarySelection, journal, restoreImplicit = false, profileCreated = false, modelTouched = false, submitted = false, browserWaiting = false, live, task, foreignActivity = false
    const issueIds = new Set(), runIds = new Set(), proofs = new Map(), workflowIds = new Set()
    const { title, content, input } = fixture
    const expectedMessages = new Map(browserSubmit ? ['en', 'zh-CN'].map(locale => [browserSubmissionText(input, locale), locale]) : [[input, 'api']])
    function ownRun(found, runId) {
      const run = found?.run, identity = run?.executionIdentity
      check(run?.id === runId && !baseline.threads.has(runId) && run.botId === botId && issueIds.has(run.issueId)
        && run.agentProfile?.profileId === fixture.profileId && identity?.requester === ownerId
        && identity.executionPrincipal === ownerId && identity.outputOwner === ownerId && identity.botOwner === ownerId
        && identity.botId === botId && identity.workspaceId === workspaceId && nativeStatuses.has(run.status), 'run_scope')
      return run
    }
    async function inspect(cleanup = false) {
      const [chat, page] = await Promise.all([read('/api/coordinator/messages', { cleanup: true }), read('/api/mobile/bots/' + botId, { cleanup: true })])
      check(Array.isArray(chat?.items) && Array.isArray(page?.threads), 'response_invalid')
      const fresh = chat.items.filter(value => value.position > baseline.chat.cursor)
      const human = fresh.filter(value => value.from === 'person'), matching = human.filter(value => expectedMessages.has(value.text))
      foreignActivity ||= human.some(value => !expectedMessages.has(value.text))
      if (browserSubmit && matching.length) {
        submitted = true
        const value = matching[0]
        check(matching.length === 1 && Number.isSafeInteger(value.position), 'fixture_ambiguous')
        if (!value.pending) {
          check(result.submission?.position === undefined || result.submission.position === value.position, 'fixture_ambiguous')
          result.submission = { source: 'browser', observed: true, position: value.position, locale: expectedMessages.get(value.text) }
        }
      }
      check(matching.length <= 1, 'fixture_ambiguous')
      if (!cleanup) check(!foreignActivity, 'foreign_activity')
      for (const value of fresh) {
        const id = typeof value.streamId === 'string' ? value.streamId.replace(/:\d+$/, '') : null
        if (WORKFLOW.test(id ?? '')) workflowIds.add(id)
      }
      for (const row of page.threads.filter(value => !baseline.threads.has(value.id))) {
        check(uuid(row.id), 'run_scope')
        const found = await read('/api/runs/' + row.id + '/evidence', { cleanup: true })
        if (found.run?.agentProfile?.profileId !== fixture.profileId) {
          foreignActivity = true
          if (!cleanup) throw new AcceptanceError('foreign_activity')
          continue
        }
        check(uuid(found.run.issueId) && !baseline.issues.has(found.run.issueId), 'task_scope')
        issueIds.add(found.run.issueId); runIds.add(row.id)
      }
      for (const [id, citation] of Object.entries(chat.sources ?? {})) {
        const candidate = citation.kind === 'issue' ? id : citation.kind === 'run' ? citation.issue?.id : null
        if (uuid(candidate) && !baseline.issues.has(candidate) && !issueIds.has(candidate)) {
          const found = await rpc('issues.getIssue', [candidate], { cleanup: true })
          if (found.issue?.userId === ownerId && found.issue.title === fixture.marker) issueIds.add(candidate)
        }
      }
      check(issueIds.size <= 1, 'fixture_ambiguous')
      for (const issueId of issueIds) {
        const issue = await rpc('issues.getIssue', [issueId], { cleanup: true })
        check(issue.issue?.id === issueId && issue.issue.userId === ownerId && issue.issue.title === fixture.marker, 'task_scope')
        const listed = await read('/api/factory/tasks?issueId=' + issueId, { cleanup: true })
        check(Array.isArray(listed.tasks) && listed.tasks.length <= 1, 'fixture_ambiguous')
        if (listed.tasks.length) {
          const state = await read('/api/factory/tasks/' + listed.tasks[0].id, { cleanup: true })
          check(uuid(state.task?.id) && state.task.issueId === issueId && state.task.botId === botId && state.task.userId === ownerId
            && taskStages.has(state.task.stage) && taskStatuses.has(state.task.status), 'task_scope')
          task = state
          for (const attempt of state.attempts ?? []) if (uuid(attempt.runId)) runIds.add(attempt.runId)
        }
      }
      for (const runId of runIds) {
        const found = await read('/api/runs/' + runId + '/evidence', { cleanup: true })
        const run = ownRun(found, runId)
        if (cleanup) proofs.set(runId, { ...(proofs.get(runId) ?? { runId }), status: run.status })
        else proofs.set(runId, runProof(found, { item, ownerId, workspaceId, botId, issueId: [...issueIds][0], profileId: fixture.profileId }))
      }
      result.workflowRunIds = [...workflowIds]
      result.runs = [...proofs.values()]
      if (task) {
        result.taskId = task.task.id; result.issueId = task.task.issueId
        result.task = { stage: task.task.stage, status: task.task.status, revision: task.task.revision }
      }
      return { chat, fresh }
    }
    async function end() {
      const cleanup = result.cleanup = { state: 'complete', profileArchived: !profileCreated, modelRestored: !modelTouched,
        evidence: 'retained', ownRunsStopped: !submitted && !browserWaiting, ownMachinesEnded: !submitted && !browserWaiting, machines: [] }
      try {
        // Reconcile a real click whose push raced the wait deadline or abort.
        if (browserWaiting) {
          await inspect(true)
          if (!submitted) {
            check(runIds.size === 0 && issueIds.size === 0, 'cleanup_incomplete')
            cleanup.ownRunsStopped = true
            cleanup.ownMachinesEnded = true
          }
        }
        if (submitted) {
          const latest = await inspect(true)
          // A shared Coordinator is stopped only while its new human messages
          // still belong exclusively to this exact submission.
          if (!foreignActivity && (latest.chat.working || latest.chat.streamRunId)) await read('/api/mobile/chat/stop', { body: { botId }, cleanup: true })
          if (task && !settledTask(task.task, task.candidates)) {
            await read('/api/factory/tasks/' + task.task.id, { body: { binding: { taskId: task.task.id, revision: task.task.revision },
              eventId: fixture.profileId, action: 'cancel', reason: 'Issue #1512 bounded acceptance completed; retain evidence.' }, cleanup: true })
          }
          for (const proof of proofs.values()) if (!nativeTerminal.has(proof.status)) {
            const stopped = await request('/api/mobile/threads/' + proof.runId + '/stop', { body: {}, cleanup: true })
            const value = await stopped.json().catch(() => null)
            check(stopped.ok || stopped.status === 409 && value?.error === 'runChainEnded', 'cleanup_incomplete')
          }
          const deadline = now() + 60_000
          for (;;) {
            const before = live.revision
            const state = await inspect(true)
            if (!state.chat.working && !state.chat.streamRunId && [...proofs.values()].every(proof => nativeTerminal.has(proof.status))
              && (!task || settledTask(task.task, task.candidates))) { cleanup.ownRunsStopped = true; break }
            await live.wait(before, deadline)
          }
        }
      } catch (error) { cleanup.state = 'incomplete'; cleanup.stopError = publicFailure(error) }
      if (submitted && cleanup.ownRunsStopped) {
        // Terminal runs can still own paused sandboxes. End only the exact runs
        // just checked above; a DB state of "ended" alone is not a kill receipt.
        for (const runId of runIds) {
          const receipt = { runId, status: 'failed' }
          cleanup.machines.push(receipt)
          try {
            const ended = await request('/api/threads/' + runId + '/machine', { body: { action: 'end' }, cleanup: true })
            const value = await ended.json().catch(() => null)
            if (ended.status === 404 && value?.error === 'Thread unavailable') {
              const found = await read('/api/runs/' + runId + '/evidence', { cleanup: true })
              check(nativeTerminal.has(ownRun(found, runId).status), 'cleanup_incomplete')
              const location = await read('/api/mobile/threads/' + runId + '/machine', { cleanup: true })
              check(location?.machine === null, 'cleanup_incomplete')
              receipt.status = 'not_created'
            } else {
              check(ended.status === 200 && value?.runId === runId && value.state === 'ended', 'cleanup_incomplete')
              receipt.status = 'ended'
            }
          } catch (error) { cleanup.state = 'incomplete'; receipt.error = publicFailure(error) }
        }
        cleanup.ownMachinesEnded = cleanup.machines.every(value => value.status !== 'failed')
      }
      // Never invalidate a running check by archiving its profile, or replace
      // a concurrent user's model setting. A failed cleanup remains visible.
      if (cleanup.ownRunsStopped && profileCreated) {
        try {
          const current = (await profileRead(fixture.profileId, { cleanup: true, missing: true }))?.profile
          if (current) {
            check(current.id === fixture.profileId && current.version === 1 && current.name === fixture.marker, 'profile_changed')
            await checkpoint(true)
            const archived = await read(profilePath(workspaceId, fixture.profileId), { method: 'DELETE',
              body: { workspaceId, version: current.version }, cleanup: true })
            check(Boolean(archived.profile?.archivedAt), 'cleanup_incomplete')
          }
          cleanup.profileArchived = true
          journal.profile.archived = true
        } catch (error) { cleanup.state = 'incomplete'; cleanup.profileError = publicFailure(error) }
        await checkpoint(true)
      }
      if (cleanup.ownRunsStopped && modelTouched) {
        try {
          if (restoreImplicit) {
            // No receipt means an uncertain first write: never guess ownership
            // from equal model values or clear a later human choice.
            check(temporarySelection, 'cleanup_incomplete')
            try {
              await checkpoint(true)
              const restored = await read('/api/mobile/model', { method: 'PUT',
                body: { bot: botId, mode: 'restore-implicit', ...temporarySelection }, cleanup: true })
              check(restored.restored === true && restored.preferenceState === 'absent', 'model_changed')
            } catch (error) {
              if (!['request_failed', 'response_invalid'].includes(error?.code)) throw error
              // An acknowledged selection allows one read after an uncertain
              // restore response. Absence is the target, not a derived default.
              check((await menuRead({ cleanup: true, inspectPreference: true })).preferenceState === 'absent', 'model_changed')
            }
          } else {
            const current = (await menuRead({ cleanup: true })).current
            if (!sameModel(current, previousModel)) {
              check(sameModel(current, selectedModel), 'model_changed')
              await checkpoint(true)
              const restored = await read('/api/mobile/model', { method: 'PUT', body: { bot: botId, id: previousModel.id }, cleanup: true })
              check(sameModel(restored.current, previousModel), 'model_changed')
            }
          }
          cleanup.modelRestored = true
          journal.model.restored = true
        } catch (error) { cleanup.state = 'incomplete'; cleanup.modelError = publicFailure(error) }
        await checkpoint(true)
      }
      live?.close()
      if (!cleanup.ownRunsStopped || !cleanup.ownMachinesEnded || !cleanup.profileArchived || !cleanup.modelRestored) cleanup.state = 'incomplete'
      if (cleanup.state !== 'complete') { result.acceptanceStatus = result.status; result.status = 'blocked'; result.code = 'cleanup_incomplete' }
    }
    try {
      await pin()
      baseline = await quiet()
      check(Number.isSafeInteger(baseline.chat.cursor), 'response_invalid')
      const state = await inventory(), planned = preflightCase(item, state)
      previousModel = state.menu.current; restoreImplicit = planned.restoreImplicit === true
      check(!await profileRead(fixture.profileId, { missing: true }), 'previous_fixture')
      live = await openLiveImpl(read, workspaceId, { now })
      result.preflight = { ownSubscription: true, cloudReady: true, workspaceIdle: true, modelRestorable: true, paidFallbackOff: true, soleFixedProfileAvailable: true, liveReady: true }
      if (!execute) { result.status = 'ready'; return result }
      journal = { case: item.id, profileId: fixture.profileId, profile: { write: 'intent', archived: false },
        model: { before: restoreImplicit ? { preferenceState: 'absent' } : { preferenceState: 'present', choice: recoveryModel(previousModel) },
          target: recoveryModel({ ...planned.option, kind: 'subscription', chosen: true }),
          write: 'not_started', temporarySelection: null, restored: false } }
      recovery.cases.push(journal)
      await quiet()
      await checkpoint()
      const profile = { name: fixture.marker, description: 'Issue #1512 bounded acceptance', enabled: true, harness: item.harness,
        model: { mode: 'fixed', harness: item.harness, model: item.model, source: planned.source.source }, effort: 'low', roles: [], skills: [], instructions: '' }
      // Deterministic request ID prevents a runner retry from spending again.
      profileCreated = true
      const created = await read(profilePath(workspaceId), { body: { workspaceId, requestId: fixture.profileId, profile } })
      check(created.profile?.id === fixture.profileId && created.profile.version === 1 && created.profile.name === fixture.marker, 'profile_scope')
      result.profileId = fixture.profileId
      journal.profile.write = 'acknowledged'; await checkpoint()
      selectedModel = { ...planned.option, kind: 'subscription', chosen: true }
      journal.model.write = 'intent'; await checkpoint()
      modelTouched = true
      let selected
      try {
        selected = await read('/api/mobile/model', { method: 'PUT', body: { bot: botId, id: planned.option.id,
          ...(restoreImplicit ? { mode: 'temporary-if-absent' } : {}) } })
      } catch (error) {
        if (restoreImplicit && error?.httpStatus === 409 && error?.serverCode === 'modelChanged') {
          modelTouched = false; journal.model.write = 'rejected'
        }
        throw error
      }
      if (restoreImplicit) {
        const receipt = selected.temporarySelection
        check(uuid(receipt?.bindingId) && typeof receipt.revision === 'string' && /^[0-9]{1,10}$/.test(receipt.revision), 'response_invalid')
        temporarySelection = { bindingId: receipt.bindingId, revision: receipt.revision }
        journal.model.temporarySelection = { ...temporarySelection }; await checkpoint()
      }
      check(selected.current?.id === planned.option.id && selected.current.kind === 'subscription' && selected.current.available === true && !selected.current.fallback, 'model_selection')
      selectedModel = selected.current
      journal.model.write = 'acknowledged'; await checkpoint()
      await pin()
      const available = await profileRead()
      check(available.profiles.filter(value => value.enabled && !value.archivedAt).every(value => value.id === fixture.profileId)
        && available.availability?.[fixture.profileId]?.available === true, 'profile_changed')
      check((await read('/api/settings/api-keys?workspace=' + workspaceId)).apiKeyAfterQuota === false, 'paid_fallback_enabled')
      check(sameModel((await menuRead()).current, selectedModel), 'model_changed')
      const deadline = now() + timeoutMs
      if (browserSubmit) {
        // New task, no project context, this workspace's Coordinator, explicit
        // Mikka Cloud and this temporary Profile. The actual browser owns its
        // submission/trace/replay IDs; the driver neither obtains nor injects them.
        browserWaiting = true; result.submission = { source: 'browser', observed: false }
        await onBrowserReady({ type: 'mikka_observability_browser_ready', version: 1, revision, case: item.id,
          workspaceId, botId, profileId: fixture.profileId, marker: fixture.marker, model: item.model, harness: item.harness,
          destination: 'cloud', input, artifact: { title, content }, expiresAt: new Date(deadline).toISOString() })
      } else {
        const traceId = randomBytes(16).toString('hex'), parentSpanId = randomBytes(8).toString('hex')
        result.requestTrace = { traceId, parentSpanId, source: 'w3c_client_parent', backendObserved: false }
        submitted = true
        const queued = await rpc('coordinator.sendCoordinatorMessage', [input, undefined, botId, fixture.profileId,
          { kind: 'cloud' }, undefined, undefined, undefined, fixture.profileId], { headers: { traceparent: '00-' + traceId + '-' + parentSpanId + '-01' } })
        check(queued.queued === true, 'submission_refused')
      }
      for (;;) {
        if (signal?.aborted) throw new AcceptanceError('interrupted')
        check(now() < deadline, 'task_timeout')
        const before = live.revision
        await pin()
        const latest = await inspect()
        const profiles = await profileRead()
        check(profiles.profiles.filter(value => value.enabled && !value.archivedAt).length === 1
          && profiles.profiles.some(value => value.id === fixture.profileId && value.version === 1 && value.enabled), 'profile_changed')
        check(sameModel((await menuRead()).current, selectedModel), 'model_changed')
        check((await read('/api/settings/api-keys?workspace=' + workspaceId)).apiKeyAfterQuota === false, 'paid_fallback_enabled')
        if (task) {
          check([...proofs.values()].every(proof => !['failed', 'stopped', 'cancelled', 'paused', 'waiting_input'].includes(proof.status)), 'run_failed')
          const reviewed = factoryReviewProof(task, proofs)
          if (reviewed && latest.chat.working === false && !latest.chat.streamRunId && workflowIds.size > 0
            && (!browserSubmit || result.submission?.observed === true)) {
            const { candidate, checks, flowVersion } = reviewed
            const produced = await read('/api/runs/' + candidate.runId + '/evidence')
            const files = (produced.artifacts ?? []).filter(value => value.title === title && uuid(value.id))
            check(files.length === 1, 'artifact_missing')
            const file = files[0]
            check(Number.isSafeInteger(file.latestVersion) && file.latestVersion > 0
              && file.url === '/mikka/api/artifacts/' + file.id + '/versions/' + file.latestVersion + '/download', 'artifact_missing')
            const response = await request(file.url)
            check(response.ok && Number(response.headers.get('content-length') ?? 0) <= 65536, 'artifact_content')
            const reader = response.body?.getReader(), chunks = []
            check(reader, 'artifact_content')
            let size = 0
            try {
              for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; check(size <= 65536, 'artifact_content'); chunks.push(next.value) }
            } finally { await reader.cancel().catch(() => {}) }
            const bytes = Buffer.concat(chunks)
            check(bytes.equals(Buffer.from(content, 'utf8')), 'artifact_content')
            result.artifact = { id: file.id, version: file.latestVersion, bytes: bytes.length, sha256: hash(bytes) }
            result.checks = checks.map(value => ({ stage: value.stage, runId: value.runId, status: 'passed' }))
            result.flowVersion = flowVersion
            const current = task.task
            check(['pending', 'waiting'].includes(current.status) && uuid(current.attemptId)
              && Number.isSafeInteger(current.revision) && current.revision > 0, 'task_acceptance')
            const binding = { taskId: current.id, issueId: current.issueId, attemptId: current.attemptId,
              candidateId: current.candidateId, revision: current.revision }
            // One ordinary Owner acceptance after verifying exact file bytes.
            // Never retry this POST, even if its response is lost.
            const accepted = await read('/api/factory/tasks/' + current.id + '/approval', { body: {
              operation: 'accept', input: { binding, eventId: fixture.profileId },
            } })
            check(accepted.status === 'accepted' && uuid(accepted.acceptanceId)
              && isDeepStrictEqual(accepted.binding, { ...binding, revision: binding.revision + 1 }), 'task_acceptance')
            await inspect()
            check(factoryReviewProof(task, proofs)?.candidate.id === candidate.id && task.task.stage === 'approval' && task.task.status === 'passed'
              && task.attempts.some(value => value.id === task.task.attemptId && value.stage === 'approval' && value.candidateId === candidate.id
                && value.status === 'passed' && value.output?.requestEpoch === task.task.sourceEventId
                && value.output?.deliverableAcceptanceId === accepted.acceptanceId), 'task_acceptance')
            result.acceptance = { status: 'accepted', id: accepted.acceptanceId, stage: 'approval' }
            result.status = 'runtime_verified'
            break
          }
        }
        await live.wait(before, deadline, signal)
      }
    } catch (error) { Object.assign(result, publicFailure(error)) }
    finally { await end(); result.durationMs = now() - started }
    return result
  }
  try {
    await checkpoint()
    await pin()
    const email = env.ACME_DEMO_EMAIL, password = env.ACME_DEMO_PASSWORD
    check(typeof email === 'string' && /^[^@\s]+@[^@\s]+$/.test(email) && typeof password === 'string' && password.length > 0, 'account_required')
    closeSession = true
    await read('/api/auth/sign-in/email', { body: { email, password } })
    const session = await read('/api/auth/get-session')
    check(session.user?.email?.toLowerCase() === email.toLowerCase() && typeof session.user.id === 'string', 'session_identity')
    ownerId = session.user.id
    Object.assign(report, await selectOwnPersonalWorkspace(read, rpc, ownerId))
    workspaceId = report.workspaceId
    const chat = await read('/api/coordinator/messages')
    check(uuid(chat.botId), 'response_invalid'); botId = chat.botId
    report.botId = botId
    check(typeof ownerId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ownerId), 'recovery_metadata_invalid')
    recovery.scope = { ownerId, workspaceId, botId }; await checkpoint()
    if (prepare) await prepareSettings()
    for (const item of cases) {
      const result = await runCase(item); report.cases.push(result)
      if (result.cleanup?.state === 'incomplete' || recovery.checkpointFailures || signal?.aborted) break
    }
    await pin()
    report.status = report.cases.length === cases.length && report.cases.every(value => value.status === (execute ? 'runtime_verified' : 'ready'))
      ? execute ? 'runtime_verified' : 'ready' : 'blocked'
  } catch (error) { Object.assign(report, publicFailure(error)) }
  finally {
    await restoreSettings()
    if (report.preparation.restoration === 'incomplete') { report.status = 'blocked'; report.code = 'preparation_restore_failed' }
    if (closeSession) report.sessionClosed = await request('/api/auth/sign-out', { body: {}, cleanup: true }).then(response => response.ok).catch(() => false)
    cookies.clear()
    if (closeSession && !report.sessionClosed) { report.status = 'blocked'; report.code = 'cleanup_incomplete' }
    report.finishedAt = new Date(now()).toISOString()
    await checkpoint(true)
    if (recovery.checkpointFailures && ['ready', 'runtime_verified'].includes(report.status)) {
      report.status = 'blocked'; report.code = 'recovery_checkpoint_failed'
    }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  let report
  try {
    const args = process.argv.slice(2)
    check(args.every(arg => ['--execute', '--prepare', '--browser-submit'].includes(arg)) && new Set(args).size === args.length, 'configuration_required')
    report = await runObservabilityAcceptance({ execute: args.includes('--execute'), prepare: args.includes('--prepare'),
      browserSubmit: args.includes('--browser-submit'), onRecoveryCheckpoint: writeRecoveryJournal, signal: controller.signal })
  } catch (error) { report = { version: 1, issue: 1512, ...publicFailure(error) } }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt) }
  const directory = 'production-run-observability-report'
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(directory + '/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  const summary = '## Run observability acceptance\n\nResult: ' + report.status + (report.code ? ' (' + report.code + ')' : '')
    + '\n\n' + (report.cases ?? []).map(value => '- ' + value.model + ': ' + value.status + (value.code ? ' (' + value.code + ')' : '')).join('\n')
    + '\n\nPostHog ingestion and real browser replay are separate verification steps.\n'
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
  if (!['ready', 'runtime_verified'].includes(report.status)) process.exitCode = 1
}
