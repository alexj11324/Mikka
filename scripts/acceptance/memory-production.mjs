#!/usr/bin/env node
/** #1821: normal-owner memory APIs and real Bot prompts on the attested main.
 * No database/cron access, synthetic notification, existing-fact edit or new
 * credential path. The CLI never treats an unavailable production fixture as
 * a passed acceptance case. Only closed observations leave this driver. */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { encode, decode } from '../../lib/desktop-rpc/wire.ts'
import { USER_ERROR_CODES } from '../../packages/protocol/src/user-error-codes.ts'
import { createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam, restoreAcceptanceWorkspace,
  chooseSharedChatModel, startupFailure } from './cloud-startup.mjs'
import { CORE_ORIGIN, assertCoreProductionTarget, attestCoreProduction, coreTargetFailure } from './self-hosted-production-target.mjs'
import { selectMemoryProduction, memorySelectionFailure } from './memory-production-target.mjs'
import { reviewPendingMemoryFixture, memoryPendingFailure } from './memory-production-pending.mjs'
import { MEMORY_CASE_STEPS, memoryCasePassed, confirmMemoryCase, memoryCaseFailure } from './memory-production-cases.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/
const count = value => Number.isSafeInteger(value) && value >= 0
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const modelCases = Object.freeze([{ harness: 'claude_code', provider: 'claude', model: 'claude-haiku-5-5' },
  { harness: 'codex', provider: 'codex', model: 'gpt-6-luna' }])
const CODES = new Set(['target_refused', 'identity_failed', 'request_failed', 'unexpected_status', 'response_invalid',
  'fixture_binding_failed', 'inventory_incomplete', 'manual_fact_failed', 'idempotency_failed', 'scope_failed',
  'remove_failed', 'undo_failed', 'baseline_changed', 'receipt_failed', 'model_unavailable', 'model_changed',
  'model_stream_failed', 'model_tools_observed', 'model_reply_failed', 'usage_not_observed', 'cleanup_failed', 'session_not_revoked'])
const BODY_CODES = new Set(['authRequired', 'workspaceAccessDenied', 'desktop_rpc_failed', 'desktop_rpc_request_invalid',
  'desktop_rpc_action_unknown', 'botNotFound', ...Object.keys(USER_ERROR_CODES)])
const BLOCKED_MODEL_CODES = new Set(['run_subscription_expired', 'run_quota_exceeded', 'run_rate_limited',
  'run_model_unavailable', 'run_timeout', 'run_network_error', 'run_provider_error',
  'subscription_hosted_runtime_unavailable', 'subscription_local_runtime_unavailable'])
const actions = new Set(['workspace.switchWorkspace', 'memory.getMemory', 'memory.addFact', 'memory.setFactScope',
  'memory.removeFact', 'memory.undoRemoveFact', 'memory.reviewFact', 'bots.pollBots', 'bots.createBot',
  'execution-settings.getBotModelMenu', 'execution-settings.chooseBotModel',
  'coordinator.sendCoordinatorMessage', 'coordinator.pollCoordinatorChat', 'coordinator.stopCoordinatorTurn'])
const businessWrites = new Set(['workspace.switchWorkspace', 'memory.addFact', 'memory.setFactScope',
  'memory.removeFact', 'memory.undoRemoveFact', 'memory.reviewFact', 'bots.createBot',
  'execution-settings.chooseBotModel', 'coordinator.sendCoordinatorMessage'])
class MemoryProbeError extends Error {
  constructor(code, httpStatus = null, body = null, options) {
    super(CODES.has(code) ? code : 'request_failed', options)
    this.httpStatus = httpStatus; this.body = body
  }
}
const check = (value, code = 'response_invalid') => { if (!value) throw new MemoryProbeError(code) }
function closedBody(value) {
  const code = typeof value?.error === 'string' ? value.error : value?.error?.code
  return { code: BODY_CODES.has(code) ? code : 'unclassified', json: true }
}
function failure(error) {
  if (error instanceof MemoryProbeError) return { code: error.message, httpStatus: error.httpStatus, ...(error.body ? { body: error.body } : {}) }
  const selection = memorySelectionFailure(error)
  if (selection) return selection
  const pending = memoryPendingFailure(error), priorCase = memoryCaseFailure(error)
  if (pending || priorCase) return pending ?? priorCase
  const core = coreTargetFailure(error)
  if (core.code !== 'core_read_failed' || error?.name === 'CoreProductionError') return core
  const startup = startupFailure(error)
  return startup.code !== 'startup_failed' ? { code: startup.code, ...(startup.httpStatus ? { httpStatus: startup.httpStatus } : {}) }
    : { code: 'request_failed', httpStatus: null }
}
async function bodyOf(response) {
  const reader = response.body?.getReader(); check(reader)
  const chunks = []; let size = 0
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break
      size += next.value.byteLength
      check(size <= 2_000_000)
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (cause) {
    await reader.cancel().catch(() => {})
    throw new MemoryProbeError('response_invalid', response.status, { json: false }, { cause })
  }
}
const rowsOf = view => [...view.facts, ...view.pending, ...view.undoable]
const factIdentity = row => JSON.stringify([row.id, row.kind, row.subject, row.userEdited, row.reviewStatus, row.source, row.scope])
function memoryView(value) {
  check(object(value) && typeof value.enabled === 'boolean' && count(value.total)
    && ['facts', 'pending', 'undoable'].every(key => Array.isArray(value[key])) && object(value.scopeOptions)
    && ['workspaces', 'projects'].every(key => Array.isArray(value.scopeOptions[key])
      && value.scopeOptions[key].every(item => UUID.test(item.id ?? '') && typeof item.name === 'string')))
  check(value.facts.length < 500 && value.pending.length < 500 && value.undoable.length < 50
    && value.total === value.facts.length, 'inventory_incomplete')
  const rows = rowsOf(value)
  check(new Set(rows.map(row => row.id)).size === rows.length && rows.every(row => UUID.test(row.id ?? '')
    && typeof row.subject === 'string' && typeof row.userEdited === 'boolean' && ['approved', 'pending'].includes(row.reviewStatus)
    && object(row.scope) && ['global', 'workspaces', 'projects'].includes(row.scope.kind) && Array.isArray(row.scope.ids)
    && row.scope.ids.every(id => UUID.test(id)) && count(row.usedCount) && Array.isArray(row.recentUses)
    && row.recentUses.length <= 5 && row.recentUses.length <= row.usedCount
    && row.recentUses.every(use => ['thread', 'task'].includes(use.kind) && UUID.test(use.id ?? '') && Number.isFinite(Date.parse(use.usedAt)))
    && (row.source === null || object(row.source) && ['thread', 'decision', 'told', 'file'].includes(row.source.kind))))
  check(value.facts.every(row => row.reviewStatus === 'approved') && value.pending.every(row => row.reviewStatus === 'pending'))
  return value
}

/** Observe the actual bounded NDJSON stream. Provider text and reasoning are
 * never returned. A usage row alone is not proof that a model answered. */
export async function readMemoryTurn(response, expectedValue) {
  check(response.status === 200 && response.body && response.headers.get('content-type')?.includes('application/x-ndjson'), 'model_stream_failed')
  const workflow = response.headers.get('x-mikka-stream-run')
  check(/^wrun_[A-Za-z0-9]+$/.test(workflow ?? ''), 'model_stream_failed')
  const reader = response.body.getReader(), decoder = new TextDecoder(), text = new Map(), committed = new Set()
  let buffer = '', bytes = 0, errored = false
  const accept = line => {
    if (!line.trim()) return
    let event
    try { event = JSON.parse(line) } catch (cause) { throw new MemoryProbeError('model_stream_failed', null, null, { cause }) }
    check(object(event), 'model_stream_failed')
    if (event.type === 'error') errored = true
    if (event.type === 'tool') throw new MemoryProbeError('model_tools_observed')
    if (['text', 'reset', 'committed'].includes(event.type)) {
      check(typeof event.id === 'string' && event.id.length <= 200, 'model_stream_failed')
      if (event.type === 'committed') committed.add(event.id)
      else {
        const value = event.type === 'text' ? event.delta : event.text
        check(typeof value === 'string', 'model_stream_failed')
        const combined = event.type === 'text' ? (text.get(event.id) ?? '') + value : value
        check(combined.length <= 16_384, 'model_stream_failed'); text.set(event.id, combined)
      }
    }
  }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) { buffer += decoder.decode(); if (buffer.trim()) accept(buffer); break }
      bytes += next.value.byteLength; check(bytes <= 1_000_000, 'model_stream_failed')
      buffer += decoder.decode(next.value, { stream: true })
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) accept(line)
    }
    check(!errored && committed.size > 0, 'model_stream_failed')
    check([...committed].some(id => text.get(id)?.trim() === expectedValue), 'model_reply_failed')
    return { committedReply: true, workflowFingerprint: digest(workflow) }
  } finally { await reader.cancel().catch(() => {}) }
}

export async function runMemoryProduction({ env = process.env, event, attestation, selection, fetchImpl = fetch,
  assertTarget = assertCoreProductionTarget, selectTarget = selectMemoryProduction,
  selectTeam = selectAcceptanceTeam, restoreWorkspace = restoreAcceptanceWorkspace,
  now = Date.now, nonce = randomUUID, writeReceipt = async () => {} } = {}) {
  const report = { schema: 1, kind: 'mikka1821-production-memory', status: 'failed', completeAcceptance: false,
    startedAt: new Date(now()).toISOString(), checks: {}, models: [], responses: [], failures: [],
    coverage: { manualSource: 'not_exercised', idempotency: 'not_exercised', workspaceScope: 'not_exercised',
      projectScope: 'not_observed', crossWorkspace: 'not_observed', removalUndo: 'not_exercised',
      pendingList: 'not_observed', pendingReview: 'not_exercised_no_owned_notification_fixture', realUse: 'not_exercised' },
    pendingFixture: { github: { status: 'not_read' } },
    pending: { status: 'not_exercised', extractionInvoked: false, existingPendingMutated: false },
    cleanup: { factRemoved: false, originalFactsPreserved: false, preferencePreserved: false,
      workspaceRestored: false, sessionRevoked: false, failures: [] },
    boundaries: { notificationInjected: false, databaseAccess: false, profileWrites: false, sharedModelOrderWrites: false,
      existingPendingReviewed: false, botDeletion: 'no_normal_owner_delete_api',
      factDeletion: 'normal_soft_delete_tombstone', undoRetention: 'two_minutes_then_existing_hourly_purge',
      modelIdentity: 'fixed_shared_subscription_selection_and_completed_bot_reply_not_native_runtime_attestation' } }
  let client, account, ownerId, originalWorkspaceId, selectedWorkspaceId, initial, originalCookie = '', source, phase = 'target'
  let factId, createAttempted = false, signInAttempted = false, closing = false, cleaning = 0, deadline = 0, target = attestation
  let marker, requestId, subject, challenge
  const ownedBots = new Map(), candidateBotIds = new Set(), baselineBotIds = new Set(), allowedWorkspaces = new Set()
  const ownedPendingFacts = new Map(), ownedPendingSuggestions = new Map()
  const boundedFetch = (url, init = {}) => {
    const duration = closing || cleaning ? 20_000 : Math.min(new URL(url).pathname.endsWith('/coordinator/stream') ? 90_000 : 20_000, deadline - now())
    check(Number.isFinite(duration) && duration > 0, 'request_failed')
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(duration)))
    return fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal })
  }
  const checkpoint = async state => {
    try {
      await writeReceipt({ schema: 1, purpose: 'mikka1821-owner-fixture', applicationSha: source,
        driverRunId: Number(env.GITHUB_RUN_ID), driverAttempt: Number(env.GITHUB_RUN_ATTEMPT),
        fixtureNonce: marker, requestId, subjectFingerprint: digest(subject), ownerFingerprint: digest(ownerId),
        factFingerprint: factId ? digest(factId) : null,
        botFingerprints: [...ownedBots.keys()].map(digest),
        notificationFacts: [...ownedPendingFacts].map(([id, row]) => ({ factFingerprint: digest(id),
          subjectFingerprint: digest(row.subject), workspaceFingerprint: digest(row.workspaceId), suggestionFingerprint: digest(row.suggestionId) })),
        state, observedAt: new Date(now()).toISOString() })
    } catch (cause) { throw new MemoryProbeError('receipt_failed', null, null, { cause }) }
  }
  const request = async (step, path, init = {}, expected = 200) => {
    phase = step
    let response
    try { response = await client.request(path, init, 30_000) }
    catch (cause) { throw new MemoryProbeError('request_failed', null, null, { cause }) }
    report.responses.push({ step, httpStatus: response.status })
    const body = await bodyOf(response)
    if (response.status !== expected) throw new MemoryProbeError('unexpected_status', response.status, closedBody(body))
    return body
  }
  const rpc = async (action, args = [], expected = 200) => {
    const body = await request(action, '/api/rpc', { ...post({ version: 1, action, args: encode(args) }),
      headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1' } }, expected)
    if (expected !== 200) return body
    check(body?.version === 1 && body.ok === true && Object.hasOwn(body, 'result'))
    const value = decode(body.result)
    // The normal chat read exposes its previous turn's error as data. Keep it
    // available for independent provider-block classification, not an RPC failure.
    if (value?.ok === false || value?.error && action !== 'coordinator.pollCoordinatorChat')
      throw new MemoryProbeError('unexpected_status', 200, closedBody(value))
    return value?.ok === true && Object.hasOwn(value, 'data') ? value.data : value
  }
  const readMemory = async () => memoryView(await rpc('memory.getMemory'))
  const switchWorkspace = async id => {
    check(allowedWorkspaces.has(id), 'identity_failed')
    const result = await rpc('workspace.switchWorkspace', [id]); check(result?.workspaceId === id, 'identity_failed')
    const current = await request('workspace_readback', '/api/workspace')
    check(current.currentUserId === ownerId && current.workspace?.id === id, 'identity_failed')
  }
  const pin = async () => {
    phase = 'target'
    const fresh = await selectTarget({ env, event, attestation: target, expectedSelection: selection, fetchImpl, now, assertTarget })
    check(fresh.selected === true && fresh.applicationSha === source && Date.parse(fresh.window?.expiresAt) > now(), 'target_refused')
    selection = fresh; target = fresh.attestation
  }
  const ownedFact = view => {
    const row = rowsOf(view).find(item => item.id === factId)
    check(row && row.subject === subject && row.kind === 'preference' && row.userEdited, 'fixture_binding_failed')
    return row
  }
  const findCreatedFact = async () => {
    const view = await readMemory(), before = new Set(rowsOf(initial).map(row => row.id))
    const matches = rowsOf(view).filter(row => row.subject === subject && !before.has(row.id)
      && row.kind === 'preference' && row.userEdited && row.reviewStatus === 'approved' && row.source?.kind === 'told'
      && row.scope.kind === 'workspaces' && row.scope.ids.length === 1 && row.scope.ids[0] === selectedWorkspaceId)
    check(matches.length === 1, 'fixture_binding_failed')
    factId = matches[0].id
    return view
  }
  const listBots = async () => {
    const value = await rpc('bots.pollBots')
    check(value?.live?.ownerId === ownerId && value.live.workspaceId === selectedWorkspaceId
      && Array.isArray(value.items) && value.items.every(row => UUID.test(row.id ?? '') && typeof row.name === 'string'))
    return value.items
  }
  const cleanupStep = async (step, work) => {
    cleaning++
    try { await work() } catch (error) { report.cleanup.failures.push({ step, ...failure(error) }) }
    finally { cleaning-- }
  }
  try {
    selection = await selectTarget({ env, event, attestation: target, expectedSelection: selection, fetchImpl, now, assertTarget })
    if (selection.selected === false) { report.status = 'not_selected'; report.code = selection.reason; return report }
    target = selection.attestation
    check(selection.selected === true && target?.status === 'ready' && target.openIssues?.includes(1821)
      && SHA.test(target.applicationSha ?? '') && Date.parse(selection.window?.expiresAt) > now(), 'target_refused')
    source = target.applicationSha; report.applicationSha = source; report.driverRunId = target.driverRunId
    report.driverRunAttempt = target.driverRunAttempt
    report.window = selection.window; report.prHeadSha = selection.headSha
    deadline = now() + 300_000
    account = smokeAcceptanceAccount(env)
    marker = nonce(); requestId = nonce(); const challengeNonce = nonce()
    check([marker, requestId, challengeNonce].every(value => UUID.test(value)), 'fixture_binding_failed')
    challenge = 'MEMORY1821_' + digest(challengeNonce).slice(0, 24)
    // The real fact store normalizes subjects to at most 80 characters. Keep
    // both the full nonce and hidden challenge intact for readback and cleanup.
    subject = `M1821 ${marker} ${challenge}`
    check([...subject].length <= 80, 'fixture_binding_failed')
    client = createSessionClient(CORE_ORIGIN, async (input, init = {}) => {
      const url = new URL(input), headers = new Headers(init.headers), path = url.pathname.slice('/mikka'.length)
      check(url.origin === CORE_ORIGIN && url.pathname.startsWith('/mikka/api/') && !headers.has('authorization'), 'target_refused')
      check(['/api/auth/sign-in/email', '/api/auth/get-session', '/api/auth/sign-out', '/api/workspace', '/api/rpc', '/api/integrations/github', '/api/inbox'].includes(path)
        || [...ownedBots.keys(), ...candidateBotIds].some(id => path === '/api/bots/' + id)
        || path === '/api/coordinator/stream' && ownedBots.has(url.searchParams.get('botId')), 'target_refused')
      let businessWrite = path === '/api/auth/sign-in/email'
      if (path === '/api/integrations/github') check((init.method ?? 'GET') === 'GET', 'target_refused')
      if (path === '/api/inbox') {
        if ((init.method ?? 'GET') === 'GET') check(allowedWorkspaces.has(url.searchParams.get('workspaceId')), 'fixture_binding_failed')
        else {
          const body = JSON.parse(init.body)
          check((closing || cleaning) && init.method === 'POST' && body.type === 'suggestion' && body.action === 'reject'
            && ownedPendingSuggestions.get(body.id) === body.workspaceId, 'fixture_binding_failed')
        }
      }
      if (path === '/api/rpc') {
        const body = JSON.parse(init.body), args = decode(body.args)
        check(actions.has(body.action), 'target_refused')
        businessWrite = businessWrites.has(body.action)
        if (['memory.removeFact', 'memory.undoRemoveFact', 'memory.setFactScope', 'memory.reviewFact'].includes(body.action))
          check(factId && args[0] === factId || ownedPendingFacts.has(args[0]), 'fixture_binding_failed')
        if (['execution-settings.getBotModelMenu', 'execution-settings.chooseBotModel', 'coordinator.pollCoordinatorChat', 'coordinator.stopCoordinatorTurn'].includes(body.action))
          check(ownedBots.has(args[0]), 'fixture_binding_failed')
        if (body.action === 'coordinator.sendCoordinatorMessage') check(ownedBots.has(args[2]) && args[9] === selectedWorkspaceId, 'fixture_binding_failed')
        if (body.action === 'memory.addFact') check(args[0]?.requestId === requestId && args[0]?.subject === subject, 'fixture_binding_failed')
      }
      if (path === '/api/auth/get-session') url.searchParams.set('disableCookieCache', 'true')
      if (signInAttempted && !originalCookie && headers.get('cookie')) originalCookie = headers.get('cookie')
      // Stop/remove/restore/logout in finally remain possible after expiry.
      // Every other write, including each model selection and send, needs the
      // same unchanged live release marker and exact deployed merge again.
      if (businessWrite && !closing && !cleaning) await pin()
      return boundedFetch(url, { ...init, headers, redirect: 'error' })
    })
    signInAttempted = true
    await request('sign_in', '/api/auth/sign-in/email', post({ ...account, rememberMe: false }))
    const session = await request('session', '/api/auth/get-session?disableCookieCache=true')
    check(session?.user?.email?.toLowerCase() === account.email.toLowerCase() && typeof session.user.id === 'string'
      && session.user.id && typeof session.session?.id === 'string' && originalCookie, 'identity_failed')
    ownerId = session.user.id
    const selected = await selectTeam(client, { ownerId }, id => { originalWorkspaceId = id })
    selectedWorkspaceId = selected?.workspaceId; check(UUID.test(selectedWorkspaceId ?? ''), 'identity_failed')
    const settings = await request('workspace', '/api/workspace')
    check(settings?.currentUserId === ownerId && settings.workspace?.id === selectedWorkspaceId
      && settings.workspace.kind === 'team' && Array.isArray(settings.choices), 'identity_failed')
    for (const row of settings.choices) { check(UUID.test(row.id ?? '')); allowedWorkspaces.add(row.id) }
    check(allowedWorkspaces.has(originalWorkspaceId), 'identity_failed')
    try {
      const github = await request('github_owner_inventory', '/api/integrations/github')
      check(github?.viewerId === ownerId && ['configured', 'connected', 'installed'].every(key => typeof github[key] === 'boolean')
        && Array.isArray(github.repositories) && github.repositories.every(repo => typeof repo.fullName === 'string'))
      report.pendingFixture.github = { status: 'read', configured: github.configured, connected: github.connected,
        installed: github.installed, source: github.source === 'cloud' ? 'cloud' : github.connected ? 'owner' : 'none',
        repositoryCount: github.repositories.length,
        mikkaRepositoryListed: github.repositories.some(repo => repo.fullName.toLowerCase() === 'alexj11324/mikka'),
        notificationDelivery: 'not_proven_by_repository_listing' }
    } catch (error) { report.pendingFixture.github = { status: 'read_failed', failure: failure(error) } }
    initial = await readMemory()
    report.checks.pendingObserved = initial.pending.length
    report.coverage.pendingList = initial.pending.length ? 'existing_pending_read_only' : 'empty_collection_contract'
    check(!rowsOf(initial).some(row => row.subject === subject), 'fixture_binding_failed')
    await pin(); await checkpoint('before_add'); createAttempted = true
    const input = { requestId, kind: 'preference', subject, scope: { kind: 'workspaces', ids: [selectedWorkspaceId] } }
    const created = await rpc('memory.addFact', [input]); check(UUID.test(created ?? ''), 'manual_fact_failed')
    let current = await findCreatedFact(); check(factId === created, 'fixture_binding_failed')
    let own = ownedFact(current)
    check(own.source?.kind === 'told' && own.source.id === factId && own.source.url === null && own.reviewStatus === 'approved'
      && own.usedCount === 0 && own.recentUses.length === 0 && JSON.stringify(own.scope) === JSON.stringify(input.scope), 'manual_fact_failed')
    report.coverage.manualSource = 'normal_owner_insert_told_assertion_id'; await checkpoint('created')
    check(await rpc('memory.addFact', [input]) === factId, 'idempotency_failed')
    current = await readMemory()
    check(current.facts.filter(row => row.subject === subject).length === 1, 'idempotency_failed')
    report.coverage.idempotency = 'same_request_id_same_fact'
    check(await rpc('memory.setFactScope', [factId, { kind: 'global', ids: [] }]) === true, 'scope_failed')
    check(ownedFact(await readMemory()).scope.kind === 'global', 'scope_failed')
    if (initial.scopeOptions.projects.length) {
      const project = initial.scopeOptions.projects[0].id
      check(await rpc('memory.setFactScope', [factId, { kind: 'projects', ids: [project] }]) === true, 'scope_failed')
      own = ownedFact(await readMemory()); check(own.scope.kind === 'projects' && own.scope.ids.length === 1 && own.scope.ids[0] === project, 'scope_failed')
      report.coverage.projectScope = 'existing_authorized_project_scope'
    }
    check(await rpc('memory.setFactScope', [factId, input.scope]) === true, 'scope_failed')
    check(JSON.stringify(ownedFact(await readMemory()).scope) === JSON.stringify(input.scope), 'scope_failed')
    const deniedId = nonce(); check(UUID.test(deniedId) && !allowedWorkspaces.has(deniedId), 'fixture_binding_failed')
    const denied = await rpc('memory.setFactScope', [factId, { kind: 'workspaces', ids: [deniedId] }], 403)
    check(denied?.ok === false && denied.error?.code === 'workspaceAccessDenied', 'scope_failed')
    report.coverage.workspaceScope = 'global_and_selected_scope_with_foreign_target_denied'
    const other = settings.choices.find(row => row.id !== selectedWorkspaceId && row.kind === 'personal')
      ?? settings.choices.find(row => row.id !== selectedWorkspaceId)
    if (other) {
      try {
        await switchWorkspace(other.id)
        check(!rowsOf(await readMemory()).some(row => row.id === factId), 'scope_failed')
        check(await rpc('memory.removeFact', [factId]) === false && await rpc('memory.undoRemoveFact', [factId]) === false
          && await rpc('memory.reviewFact', [factId, 'approve']) === false
          && await rpc('memory.setFactScope', [factId, { kind: 'global', ids: [] }]) === false, 'scope_failed')
        report.coverage.crossWorkspace = 'hidden_and_mutations_refused_for_own_fixture'
      } finally { await switchWorkspace(selectedWorkspaceId) }
    }
    check(await rpc('memory.removeFact', [factId]) === true, 'remove_failed')
    current = await readMemory()
    check(!current.facts.some(row => row.id === factId) && !current.pending.some(row => row.id === factId), 'remove_failed')
    const undo = ownedFact(current)
    check(current.undoable.some(row => row.id === factId) && Number.isFinite(Date.parse(undo.undoUntil))
      && Date.parse(undo.undoUntil) > now() && Date.parse(undo.undoUntil) <= now() + 135_000, 'undo_failed')
    check(await rpc('memory.undoRemoveFact', [factId]) === true, 'undo_failed')
    own = ownedFact(await readMemory())
    check(own.source?.kind === 'told' && own.source.id === factId && own.source.url === null
      && own.reviewStatus === 'approved' && JSON.stringify(own.scope) === JSON.stringify(input.scope), 'undo_failed')
    check(await rpc('memory.undoRemoveFact', [factId]) === true, 'undo_failed')
    report.coverage.removalUndo = 'removed_then_restored_within_two_minutes'
    report.checks.ownerCrud = true
    if (selection.cases?.pending?.reused) {
      report.pending = { status: 'reused', proof: selection.cases.pending.reused, extractionInvoked: false, existingPendingMutated: false }
      report.coverage.pendingReview = 'reused_exact_source_run_attempt_case'
    } else if (selection.notification) {
      const personal = settings.choices.filter(row => row.kind === 'personal')
      try {
        check(personal.length === 1 && allowedWorkspaces.has(personal[0].id), 'identity_failed')
        await switchWorkspace(personal[0].id)
        await reviewPendingMemoryFixture({ proof: selection.notification, ownerId, workspaceId: personal[0].id,
          otherWorkspaceId: selectedWorkspaceId, readMemory, request, rpc, switchWorkspace, cleanupStep, report: report.pending, now,
          bind: (row, workspaceId, suggestionId) => {
            check(UUID.test(row.id) && row.id !== factId && !initial.facts.some(old => old.id === row.id), 'fixture_binding_failed')
            ownedPendingFacts.set(row.id, { subject: row.subject, kind: row.kind, workspaceId, suggestionId })
            ownedPendingSuggestions.set(suggestionId, workspaceId)
          },
          saveReceipt: () => checkpoint('notification_fixture_bound_or_cleaned') })
        report.coverage.pendingReview = 'real_notification_reject_undo_approve_and_cleanup'
      } catch (error) { report.pending.status = 'failed'; report.pending.failure = failure(error) }
      finally { await cleanupStep('restore_team_after_pending', () => switchWorkspace(selectedWorkspaceId)) }
    } else report.pending = { status: 'awaiting_fixture', reason: 'no_registered_real_notification',
      extractionInvoked: false, existingPendingMutated: false,
      producerBoundary: 'normal_notification_ingest_only_builtin_extraction_not_forced_or_paid_retried' }
    if (initial.enabled) {
      for (const bot of await listBots()) baselineBotIds.add(bot.id)
      for (const sample of modelCases) {
        const reused = selection.cases?.[sample.harness]?.reused
        if (reused) { report.models.push({ ...sample, status: 'reused', proof: reused }); continue }
        const result = { ...sample, status: 'failed', reply: false, usage: false, botStopped: false }
        report.models.push(result)
        let botId, botName = `测试1821 ${marker} ${sample.harness}`, botAttempted = false, promptSent = false
        try {
          await pin(); await checkpoint('before_bot_' + sample.harness)
          botAttempted = true
          const bot = await rpc('bots.createBot', [{ name: botName, color: 'gris', shape: 'cercle', model: null, repository: null }])
          check(UUID.test(bot?.id ?? '') && !baselineBotIds.has(bot.id), 'fixture_binding_failed')
          candidateBotIds.add(bot.id)
          const read = await request('bot_identity', '/api/bots/' + bot.id)
          check(read.id === bot.id && read.name === botName, 'fixture_binding_failed')
          botId = bot.id; ownedBots.set(botId, botName)
          await checkpoint('bot_created_' + sample.harness)
          await chooseSharedChatModel(client, botId, sample.harness)
          const chosen = await rpc('execution-settings.getBotModelMenu', [botId])
          const exactModel = current => current?.kind === 'subscription' && current.chosen === true
            && current.provider === sample.provider && current.modelId === sample.model && current.fallback === undefined
            && (current.available === true || current.availability === 'checking') && !current.quota?.fallback
          check(exactModel(chosen.current), 'model_unavailable')
          const beforeUse = ownedFact(await readMemory()).usedCount
          const prompt = `这是只读记忆验收。请从已提供的个人事实中找到 M1821 ${marker} 后面的值，只回复该值。不要调用工具，不要创建任务、派发工作、访问外部服务或修改任何数据。找不到就回复 MISSING。`
          check((await rpc('coordinator.sendCoordinatorMessage', [prompt, null, botId, nonce(), undefined, null, [], undefined, undefined, selectedWorkspaceId]))?.queued === true)
          promptSent = true
          phase = 'model_stream'
          const stream = await client.request('/api/coordinator/stream?botId=' + botId + '&wait=1', {}, 90_000)
          report.responses.push({ step: 'model_stream', httpStatus: stream.status })
          const observed = await readMemoryTurn(stream, challenge)
          result.reply = observed.committedReply; result.workflowFingerprint = observed.workflowFingerprint
          const used = ownedFact(await readMemory())
          check(used.usedCount > beforeUse && used.recentUses.some(use => use.kind === 'thread' && use.id === botId), 'usage_not_observed')
          result.usage = true; result.usedCountIncrease = used.usedCount - beforeUse
          check(exactModel((await rpc('execution-settings.getBotModelMenu', [botId])).current), 'model_changed')
          await pin(); result.status = 'passed'
        } catch (error) {
          result.failure = failure(error)
          if (result.failure.code === 'model_unavailable' || ['startup_shared_chat_model_ambiguous', 'startup_shared_chat_model_unavailable'].includes(result.failure.code)) result.status = 'blocked'
          // A provider failure can explain an unanswered prompt. It cannot
          // downgrade a proven post-reply usage/target/selection defect.
          if (botId && promptSent && !result.reply) {
            try {
              const chat = await rpc('coordinator.pollCoordinatorChat', [botId])
              const providerCode = BLOCKED_MODEL_CODES.has(chat?.error) ? chat.error : BLOCKED_MODEL_CODES.has(chat?.cause) ? chat.cause : null
              if (providerCode) { result.status = 'blocked'; result.providerCode = providerCode }
            } catch { /* The original closed failure stays recorded. */ }
          }
        } finally {
          if (botAttempted && !botId) {
            await cleanupStep('recover_bot_' + sample.harness, async () => {
              const matches = (await listBots()).filter(bot => bot.name === botName && !baselineBotIds.has(bot.id))
              check(matches.length === 1, 'fixture_binding_failed'); botId = matches[0].id; ownedBots.set(botId, botName)
            })
          }
          if (botId) await cleanupStep('stop_bot_' + sample.harness, async () => {
            const stopped = await rpc('coordinator.stopCoordinatorTurn', [botId]); check(typeof stopped?.stopped === 'boolean', 'cleanup_failed')
            check((await rpc('coordinator.pollCoordinatorChat', [botId]))?.working === false, 'cleanup_failed')
            result.botStopped = true
          })
        }
      }
      report.coverage.realUse = report.models.every(row => ['passed', 'reused'].includes(row.status)) ? 'both_fixed_subscription_bot_replies_and_usage_observed'
        : report.models.some(row => ['passed', 'reused'].includes(row.status)) ? 'one_subscription_observed_other_incomplete' : 'not_observed'
    } else for (const sample of modelCases) {
      const reused = selection.cases?.[sample.harness]?.reused
      report.models.push(reused ? { ...sample, status: 'reused', proof: reused }
        : { ...sample, status: 'blocked', reason: 'existing_memory_preference_disabled' })
    }
    await pin(); report.checks.finalTarget = true
  } catch (error) { report.failures.push({ phase, ...failure(error) }) }
  finally {
    closing = true
    if (client && signInAttempted) {
      if (selectedWorkspaceId && allowedWorkspaces.has(selectedWorkspaceId)) {
        await cleanupStep('select_fixture_workspace', () => switchWorkspace(selectedWorkspaceId))
        if (createAttempted) await cleanupStep('remove_owned_fact', async () => {
          if (!factId) await findCreatedFact()
          const before = await readMemory(); ownedFact(before)
          check(await rpc('memory.removeFact', [factId]) === true, 'cleanup_failed')
          const after = await readMemory()
          check(!after.facts.some(row => row.id === factId) && !after.pending.some(row => row.id === factId), 'cleanup_failed')
          const tombstone = after.undoable.find(row => row.id === factId)
          check(!tombstone || tombstone.subject === subject && tombstone.source === null, 'cleanup_failed')
          report.cleanup.factRemoved = true
          report.cleanup.undoUntil = tombstone?.undoUntil ?? null
          report.cleanup.originalFactsPreserved = [...initial.facts, ...initial.pending].filter(row => !ownedPendingFacts.has(row.id)).every(row =>
            [...after.facts, ...after.pending].some(next => factIdentity(next) === factIdentity(row)))
          report.cleanup.preferencePreserved = after.enabled === initial.enabled
          check(report.cleanup.originalFactsPreserved && report.cleanup.preferencePreserved, 'baseline_changed')
          await checkpoint('normal_soft_delete_confirmed')
        })
      }
      if (originalWorkspaceId) await cleanupStep('restore_workspace', async () => {
        await restoreWorkspace(client, ownerId, originalWorkspaceId); report.cleanup.workspaceRestored = true
      })
      await cleanupStep('sign_out', async () => {
        await request('sign_out', '/api/auth/sign-out', post({}))
        check(originalCookie, 'session_not_revoked')
        const response = await boundedFetch(CORE_ORIGIN + '/mikka/api/auth/get-session?disableCookieCache=true',
          { method: 'GET', redirect: 'error', headers: { cookie: originalCookie, origin: CORE_ORIGIN, 'cache-control': 'no-store' } })
        report.responses.push({ step: 'old_cookie_readback', httpStatus: response.status })
        const session = await bodyOf(response)
        check(response.status === 200 && (!session || !session.user && !session.session), 'session_not_revoked')
        report.cleanup.sessionRevoked = true
      })
      client.clear()
    }
    if (source) {
      try { await pin(); report.checks.finalTarget = true }
      catch (error) { report.failures.push({ phase: 'final_target', ...failure(error) }) }
    }
    report.finishedAt = new Date(now()).toISOString()
  }
  const clean = report.cleanup.factRemoved && report.cleanup.originalFactsPreserved && report.cleanup.preferencePreserved
    && report.cleanup.workspaceRestored && report.cleanup.sessionRevoked && !report.cleanup.failures.length
  const pendingPassed = ['passed', 'reused'].includes(report.pending.status)
  report.completeAcceptance = !report.failures.length && report.checks.ownerCrud === true && clean && pendingPassed
    && report.models.length === 2 && report.models.every(row => ['passed', 'reused'].includes(row.status))
  report.status = report.failures.length || !report.checks.ownerCrud || !clean || report.models.some(row => row.status === 'failed')
    || report.pending.status === 'failed' ? 'failed' : report.completeAcceptance ? 'passed' : 'partial'
  // A missing actual notification is not approval coverage. Already confirmed
  // subscription cases remain reusable without sending another paid prompt.
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = 'memory-production-report'
  const selectOnly = process.argv.length === 3 && process.argv[2] === '--select'
  const confirming = process.argv.length === 4 && process.argv[2] === '--confirm-case' && Object.hasOwn(MEMORY_CASE_STEPS, process.argv[3])
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let report
  try {
    check(selectOnly || confirming || process.argv.length === 2, 'target_refused')
    if (confirming) report = confirmMemoryCase(JSON.parse(await readFile(directory + '/report.json', 'utf8')), process.argv[3], process.env)
    else {
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
      if (selectOnly) report = await selectMemoryProduction({ event })
      else {
        const selection = JSON.parse(await readFile(directory + '/selection.json', 'utf8'))
        check(selection?.purpose === 'memory-1821-production-selection' && selection.selected === true, 'target_refused')
        const attestation = await attestCoreProduction({ event })
        report = await runMemoryProduction({ event, attestation, selection,
          writeReceipt: receipt => writeFile(directory + '/fixture.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }) })
      }
    }
  } catch (error) { report = { schema: 1, kind: 'mikka1821-production-memory', status: 'failed', completeAcceptance: false, failure: failure(error) } }
  const json = JSON.stringify(report, null, 2) + '\n'
  await writeFile(directory + (selectOnly ? '/selection.json' : confirming ? '/confirmation-' + process.argv[3] + '.json' : '/report.json'), json, { mode: 0o600 })
  if (selectOnly && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'selected=' + (report.selected === true) + '\n')
  if (!selectOnly && !confirming && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    Object.keys(MEMORY_CASE_STEPS).map(kind => kind + '_passed=' + memoryCasePassed(report, kind)).join('\n') + '\n')
  console.log(json)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '## #1821 memory production ' + (selectOnly ? 'selection' : 'API acceptance') + '\n\nResult: ' + report.status
      + '. Pending positive review and every model path have separate coverage; partial is not complete acceptance.\n\n```json\n' + json + '```\n')
  process.exitCode = ['passed', 'not_selected', 'selected'].includes(report.status) ? 0 : 1
}
