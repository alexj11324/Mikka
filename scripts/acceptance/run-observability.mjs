#!/usr/bin/env node
/**
 * Issue #1512, ordinary production account only. Default: read-only preflight
 * (apart from creating/closing its own login session). --execute submits one
 * small Factory deliverable on each required subscription, once per deployment.
 *
 * Node 24: node scripts/acceptance/run-observability.mjs [--execute]
 * Required env: ACME_DEMO_EMAIL, ACME_DEMO_PASSWORD, MIKKA_EXPECTED_DEPLOYMENT_SHA.
 * Optional: MIKKA_OBSERVABILITY_MODEL_CASE=all|claude|codex; timeout per model
 * MIKKA_OBSERVABILITY_TIMEOUT_MS (60_000..600_000, default 480_000).
 * Infisical credentials stay in the runner. Never enable fetch/HTTP debug output.
 * One execute/review/verify is allowed; first observed excess triggers stop.
 * No endpoint provides a hard dollar cap or synchronous native-attempt fence.
 * PostHog/APM ingestion and real browser replay require independent verification.
 */
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { decode, encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { liveInvalidation, liveReadiness } from '../../lib/live/events.ts'
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
])
const serverCodes = new Set(['authRequired', 'modelUnavailable', 'factoryStale', 'factoryStopped', 'runChainEnded',
  'agentProfileNotFound', 'agentProfileRequestConflict', 'agentProfileVersionConflict', 'subscriptionConflict',
  'coordinatorUnavailable', 'issueToolsDisabled', 'submissionConflict', 'validationGeneric'])
export class AcceptanceError extends Error {
  constructor(code, options = {}) { super(errorCodes.has(code) ? code : 'acceptance_failed', options); this.code = this.message }
}
const check = (condition, code) => { if (!condition) throw new AcceptanceError(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const uuid = value => typeof value === 'string' && UUID.test(value)
const settledTask = task => ['cancelled', 'revoked', 'completed', 'succeeded'].includes(task.status) || task.stage === 'monitor' && task.status === 'passed'
const sameModel = (a, b) => a?.id === b?.id && a?.kind === b?.kind && a?.modelId === b?.modelId && a?.provider === b?.provider && a?.chosen === b?.chosen && !a?.fallback
const sourceKey = value => JSON.stringify([value?.harness, value?.model, value?.source?.kind, value?.source?.connectionId])
const profilePath = (workspaceId, id = '') => '/api/factory/agent-profiles' + (id ? '/' + id : '') + '?workspaceId=' + workspaceId

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
/** No mutable owner-wide preferences are changed. A sole fixed Profile also
 * pins Factory's independent checks; its native receipt proves that selection. */
export function preflightCase(item, { ownerId, menu, order, connections, keys, profiles }) {
  check(Array.isArray(menu?.groups) && Array.isArray(order?.candidates) && Array.isArray(order?.entries)
    && Array.isArray(connections?.connections) && Array.isArray(profiles?.profiles), 'response_invalid')
  check(keys?.apiKeyAfterQuota === false, 'paid_fallback_enabled')
  check(profiles.profiles.every(profile => profile.enabled === false || profile.archivedAt), 'profiles_active')
  const current = menu.current
  check(current?.chosen === true && current.available === true && !current.fallback && typeof current.id === 'string'
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
  return { option: options[0], source }
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
export function assertAttemptBudget(attempts) {
  const runs = attempts.filter(attempt => uuid(attempt.runId))
  check(runs.length <= 3 && new Set(runs.map(attempt => attempt.runId)).size === runs.length
    && runs.every(attempt => ['execute', 'review', 'verify'].includes(attempt.stage))
    && new Set(runs.map(attempt => attempt.stage)).size === runs.length, 'budget_exceeded')
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

export async function runObservabilityAcceptance({ env = process.env, execute = false, fetchImpl = fetch, now = Date.now, openLiveImpl = openLive, signal } = {}) {
  const revision = env.MIKKA_EXPECTED_DEPLOYMENT_SHA
  const timeoutMs = Number(env.MIKKA_OBSERVABILITY_TIMEOUT_MS ?? 480_000)
  const modelCase = env.MIKKA_OBSERVABILITY_MODEL_CASE ?? 'all'
  check(['all', 'claude', 'codex'].includes(modelCase), 'configuration_required')
  const cases = CASES.filter(item => modelCase === 'all' || item.id === modelCase)
  check(SHA.test(revision ?? '') && Number.isSafeInteger(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 600_000, 'configuration_required')
  check(!env.MIKKA_ACCEPTANCE_BASE_URL || env.MIKKA_ACCEPTANCE_BASE_URL === ORIGIN + '/mikka', 'origin_rejected')
  const report = { version: 1, issue: 1512, revision, mode: execute ? 'execute' : 'preflight', status: 'running',
    startedAt: new Date(now()).toISOString(), browserReplayVerified: false, posthogIngestionVerified: false,
    budget: { submissionsPerModel: 1, nativeRunsPerModel: 3, enforcement: 'stop_on_first_observed_excess', timeoutMs, paidResubmissions: 0, hardDollarCap: false },
    modelCase, cases: [], sessionClosed: false }
  const cookies = responseCookieJar(now)
  let ownerId, workspaceId, botId, closeSession = false
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', headers: extra, cleanup = false } = {}) {
    check(path.startsWith('/api/') || path.startsWith('/mikka/api/artifacts/'), 'origin_rejected')
    const url = new URL(path.startsWith('/mikka/') ? path : '/mikka' + path, ORIGIN)
    check(url.origin === ORIGIN && !url.username && !url.password && !url.hash, 'origin_rejected')
    if (!cleanup && signal?.aborted) throw new AcceptanceError('interrupted')
    const headers = new Headers({ origin: ORIGIN, 'cache-control': 'no-store', accept: 'application/json', ...extra })
    const cookie = cookies.header(url); if (cookie) headers.set('cookie', cookie)
    if (body !== undefined) headers.set('content-type', 'application/json')
    let response
    try {
      response = await fetchImpl(url, { method, headers, redirect: 'error',
        signal: !cleanup && signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (cause) { throw new AcceptanceError(!cleanup && signal?.aborted ? 'interrupted' : 'request_failed', { cause }) }
    cookies.receive(url, response.headers)
    return response
  }
  async function read(path, options = {}) {
    const response = await request(path, options)
    if (options.missing && response.status === 404) return null
    const value = await response.json().catch(() => null)
    if (!response.ok || value?.error) {
      const error = new AcceptanceError('http_refused')
      error.httpStatus = response.status; error.serverCode = typeof value?.error === 'string' ? value.error : value?.error?.code
      throw error
    }
    check(value !== null, 'response_invalid')
    return value
  }
  async function rpc(action, args, options = {}) {
    check(['coordinator.sendCoordinatorMessage', 'issues.getIssue', 'agents.getIssueThread'].includes(action), 'configuration_required')
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
  const menuRead = (options = {}) => read('/api/mobile/model?bot=' + botId, options)
  async function quiet() {
    const [bots, threads, tasks, chat] = await Promise.all([
      read('/api/settings/workspace-bots'), read('/api/mobile/threads'), read('/api/mobile/tasks'), read('/api/coordinator/messages'),
    ])
    check(Array.isArray(bots?.bots) && Array.isArray(threads?.threads) && Array.isArray(tasks?.tasks) && Array.isArray(chat?.items), 'response_invalid')
    check(bots.bots.every(bot => bot.status === 'idle' && bot.runningThreads === 0)
      && threads.threads.every(thread => ['failed', 'done', 'stopped'].includes(thread.status)), 'workspace_busy')
    check(tasks.tasks.length < 100, 'task_inventory_truncated')
    for (const task of tasks.tasks) {
      check(uuid(task.id), 'response_invalid')
      const ledger = await read('/api/factory/tasks?issueId=' + task.id)
      check(Array.isArray(ledger.tasks) && ledger.tasks.every(settledTask), 'workspace_busy')
    }
    check(chat.botId === botId && chat.enabled === true, 'coordinator_disabled')
    check(chat.working === false && !chat.streamRunId && !chat.items.some(item => item.pending), 'coordinator_busy')
    return { chat, threads: new Set(threads.threads.map(thread => thread.id)), issues: new Set(tasks.tasks.map(task => task.id)) }
  }
  async function inventory() {
    const [menu, order, connections, keys, profiles] = await Promise.all([
      menuRead(), read('/api/settings/model-order?workspace=' + workspaceId), read('/api/subscriptions?workspace=' + workspaceId),
      read('/api/settings/api-keys?workspace=' + workspaceId), profileRead(),
    ])
    return { ownerId, menu, order, connections, keys, profiles }
  }
  async function runCase(item) {
    const result = { case: item.id, model: item.model, status: 'running', cleanup: { state: 'not_created' } }
    const fixture = fixtureIdentity(revision, item)
    const started = now()
    let baseline, previousModel, selectedModel, profileCreated = false, modelTouched = false, submitted = false, live, task, foreignActivity = false
    const issueIds = new Set(), runIds = new Set(), proofs = new Map(), workflowIds = new Set()
    const title = fixture.marker + '.txt', content = 'mikka-observability:' + fixture.marker + '\nstatus=ready\n'
    async function inspect(cleanup = false) {
      const [chat, page] = await Promise.all([read('/api/coordinator/messages', { cleanup: true }), read('/api/mobile/bots/' + botId, { cleanup: true })])
      check(Array.isArray(chat?.items) && Array.isArray(page?.threads), 'response_invalid')
      const fresh = chat.items.filter(value => value.position > baseline.chat.cursor)
      foreignActivity ||= fresh.filter(value => value.from === 'person').some(value => !value.text?.includes(fixture.marker))
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
        const run = found?.run, identity = run?.executionIdentity
        check(run?.id === runId && run.botId === botId && issueIds.has(run.issueId) && run.agentProfile?.profileId === fixture.profileId
          && identity?.requester === ownerId && identity.executionPrincipal === ownerId && identity.outputOwner === ownerId
          && identity.botOwner === ownerId && identity.botId === botId && identity.workspaceId === workspaceId && nativeStatuses.has(run.status), 'run_scope')
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
        evidence: 'retained', ownRunsStopped: !submitted }
      try {
        if (submitted) {
          const latest = await inspect(true)
          // A shared Coordinator is stopped only while its new human messages
          // still belong exclusively to this exact submission.
          if (!foreignActivity && (latest.chat.working || latest.chat.streamRunId)) await read('/api/mobile/chat/stop', { body: { botId }, cleanup: true })
          if (task && !settledTask(task.task)) {
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
              && (!task || settledTask(task.task))) { cleanup.ownRunsStopped = true; break }
            await live.wait(before, deadline)
          }
        }
      } catch (error) { cleanup.state = 'incomplete'; cleanup.stopError = publicFailure(error) }
      // Never invalidate a running check by archiving its profile, or replace
      // a concurrent user's model setting. A failed cleanup remains visible.
      if (cleanup.ownRunsStopped && profileCreated) {
        try {
          const current = (await profileRead(fixture.profileId, { cleanup: true, missing: true }))?.profile
          if (current) {
            check(current.id === fixture.profileId && current.version === 1 && current.name === fixture.marker, 'profile_changed')
            const archived = await read(profilePath(workspaceId, fixture.profileId), { method: 'DELETE',
              body: { workspaceId, version: current.version }, cleanup: true })
            check(Boolean(archived.profile?.archivedAt), 'cleanup_incomplete')
          }
          cleanup.profileArchived = true
        } catch (error) { cleanup.state = 'incomplete'; cleanup.profileError = publicFailure(error) }
      }
      if (cleanup.ownRunsStopped && modelTouched) {
        try {
          const current = (await menuRead({ cleanup: true })).current
          if (!sameModel(current, previousModel)) {
            check(sameModel(current, selectedModel), 'model_changed')
            const restored = await read('/api/mobile/model', { method: 'PUT', body: { bot: botId, id: previousModel.id }, cleanup: true })
            check(sameModel(restored.current, previousModel), 'model_changed')
          }
          cleanup.modelRestored = true
        } catch (error) { cleanup.state = 'incomplete'; cleanup.modelError = publicFailure(error) }
      }
      live?.close()
      if (!cleanup.ownRunsStopped || !cleanup.profileArchived || !cleanup.modelRestored) cleanup.state = 'incomplete'
      if (cleanup.state !== 'complete') { result.acceptanceStatus = result.status; result.status = 'blocked'; result.code = 'cleanup_incomplete' }
    }
    try {
      await pin()
      baseline = await quiet()
      check(Number.isSafeInteger(baseline.chat.cursor), 'response_invalid')
      const state = await inventory(), planned = preflightCase(item, state)
      previousModel = state.menu.current
      check(!await profileRead(fixture.profileId, { missing: true }), 'previous_fixture')
      live = await openLiveImpl(read, workspaceId, { now })
      result.preflight = { ownSubscription: true, cloudReady: true, workspaceIdle: true, modelRestorable: true, paidFallbackOff: true, soleFixedProfileAvailable: true, liveReady: true }
      if (!execute) { result.status = 'ready'; return result }
      await quiet()
      const profile = { name: fixture.marker, description: 'Issue #1512 bounded acceptance', enabled: true, harness: item.harness,
        model: { mode: 'fixed', harness: item.harness, model: item.model, source: planned.source.source }, effort: 'low', roles: [], skills: [], instructions: '' }
      // Deterministic request ID prevents a runner retry from spending again.
      profileCreated = true
      const created = await read(profilePath(workspaceId), { body: { workspaceId, requestId: fixture.profileId, profile } })
      check(created.profile?.id === fixture.profileId && created.profile.version === 1 && created.profile.name === fixture.marker, 'profile_scope')
      result.profileId = fixture.profileId
      selectedModel = { ...planned.option, kind: 'subscription', chosen: true }
      modelTouched = true
      const selected = await read('/api/mobile/model', { method: 'PUT', body: { bot: botId, id: planned.option.id } })
      check(selected.current?.id === planned.option.id && selected.current.kind === 'subscription' && selected.current.available === true && !selected.current.fallback, 'model_selection')
      selectedModel = selected.current
      await pin()
      const available = await profileRead()
      check(available.profiles.filter(value => value.enabled && !value.archivedAt).every(value => value.id === fixture.profileId)
        && available.availability?.[fixture.profileId]?.available === true, 'profile_changed')
      check((await read('/api/settings/api-keys?workspace=' + workspaceId)).apiKeyAfterQuota === false, 'paid_fallback_enabled')
      check(sameModel((await menuRead()).current, selectedModel), 'model_changed')
      const traceId = randomBytes(16).toString('hex'), parentSpanId = randomBytes(8).toString('hex')
      result.requestTrace = { traceId, parentSpanId, source: 'w3c_client_parent', backendObserved: false }
      const prompt = '请创建且只创建一个 Factory 任务，标题必须为 ' + fixture.marker + '。在所选云端和固定 Agent Profile 上完成一次很小的真实交付：创建名称为 ' + title
        + ' 的纯文本 Artifact，UTF-8 内容必须精确等于这个 JSON 字符串解码后的字节（包括末尾换行）：' + JSON.stringify(content)
        + '。实际读取文件验证后，通过正常 Artifact 工具提交，交给独立 review 和 verify。使用选中的 Profile，所有阶段只允许我的官方订阅 ' + item.model
        + '，失败就停止；不要切换账号、API Key、模型，或重试/修复/创建第二个任务。不要外部发消息、推送代码或改别的资源。完成后只回复此任务、线程和 Artifact 链接。'
      submitted = true
      const queued = await rpc('coordinator.sendCoordinatorMessage', [prompt, undefined, botId, fixture.profileId,
        { kind: 'cloud' }, undefined, undefined, undefined, fixture.profileId], { headers: { traceparent: '00-' + traceId + '-' + parentSpanId + '-01' } })
      check(queued.queued === true, 'submission_refused')
      const deadline = now() + timeoutMs
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
        if (task) {
          assertAttemptBudget(task.attempts ?? [])
          check([...proofs.values()].every(proof => !['failed', 'stopped', 'cancelled', 'paused', 'waiting_input'].includes(proof.status)), 'run_failed')
          const candidate = task.candidates?.find(value => value.id === task.task.candidateId)
          const checks = (task.attempts ?? []).filter(value => value.candidateId === candidate?.id && ['review', 'verify'].includes(value.stage) && value.status === 'passed')
          if (candidate && uuid(candidate.runId) && checks.length === 2 && new Set(checks.map(value => value.stage)).size === 2
            && [candidate.runId, ...checks.map(value => value.runId)].every(id => proofs.get(id)?.status === 'succeeded')
            && checks.every(value => value.output?.requestEpoch === task.task.sourceEventId)
            && latest.chat.working === false && workflowIds.size > 0) {
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
            result.status = 'runtime_verified'
            break
          }
          check(!['failed', 'blocked', 'cancelled', 'revoked'].includes(task.task.status), 'task_blocked')
        }
        await live.wait(before, deadline, signal)
      }
    } catch (error) { Object.assign(result, publicFailure(error)) }
    finally { await end(); result.durationMs = now() - started }
    return result
  }
  try {
    await pin()
    const email = env.ACME_DEMO_EMAIL, password = env.ACME_DEMO_PASSWORD
    check(typeof email === 'string' && /^[^@\s]+@[^@\s]+$/.test(email) && typeof password === 'string' && password.length > 0, 'account_required')
    closeSession = true
    await read('/api/auth/sign-in/email', { body: { email, password } })
    const session = await read('/api/auth/get-session')
    check(session.user?.email?.toLowerCase() === email.toLowerCase() && typeof session.user.id === 'string', 'session_identity')
    ownerId = session.user.id
    const workspace = await read('/api/workspace')
    check(uuid(workspace.workspace?.id) && workspace.currentUserId === ownerId && workspace.workspace.kind === 'personal' && workspace.role === 'admin', 'workspace_missing')
    workspaceId = workspace.workspace.id
    const chat = await read('/api/coordinator/messages')
    check(uuid(chat.botId), 'response_invalid'); botId = chat.botId
    report.botId = botId; report.workspaceId = workspaceId
    for (const item of cases) {
      const result = await runCase(item); report.cases.push(result)
      if (result.cleanup?.state === 'incomplete' || signal?.aborted) break
    }
    await pin()
    report.status = report.cases.length === cases.length && report.cases.every(value => value.status === (execute ? 'runtime_verified' : 'ready'))
      ? execute ? 'runtime_verified' : 'ready' : 'blocked'
  } catch (error) { Object.assign(report, publicFailure(error)) }
  finally {
    if (closeSession) report.sessionClosed = await request('/api/auth/sign-out', { body: {}, cleanup: true }).then(response => response.ok).catch(() => false)
    cookies.clear()
    if (closeSession && !report.sessionClosed) { report.status = 'blocked'; report.code = 'cleanup_incomplete' }
    report.finishedAt = new Date(now()).toISOString()
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  let report
  try {
    check(process.argv.slice(2).every(arg => arg === '--execute') && process.argv.length <= 3, 'configuration_required')
    report = await runObservabilityAcceptance({ execute: process.argv.includes('--execute'), signal: controller.signal })
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
