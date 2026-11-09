/** Fixed ordinary-session inventory before a real #1687 baseline.
 * No prompt, Task, model choice, defaults change, direct DB or GitHub mutation.
 * Normal getters may initialize the Coordinator and refresh catalogues. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { workflowGuard } from './self-hosted-closeout.mjs'
import { createSessionClient, decodeWire, smokeAcceptanceAccount } from '../acceptance/cloud-startup.mjs'
import { readHistoryTaskAccess } from './domain-history-before-1782.mjs'

const REPO = 'alexj11324/Mikka', BRANCH = 'ops/self-hosted-vault-closeout-20261108'
const API = 'https://api.github.com/repos/' + REPO, ORIGIN = 'https://app.aspectlylabs.com'
const PATH = '.github/workflows/issue1782-publication-preflight.yml'
const REPOSITORY = 'alexj11324/Mikka-handoff'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const MODELS = Object.freeze({ claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' })
const TERMINAL = new Set(['succeeded', 'stopped', 'failed', 'cancelled'])
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const exact = (row, keys) => row && typeof row === 'object' && !Array.isArray(row)
  && isDeepStrictEqual(Object.keys(row).sort(), [...keys].sort())
const positive = value => Number.isSafeInteger(value) && value > 0
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const CODES = new Set(['binding_refused', 'source_refused', 'main_changed', 'build_changed', 'window_changed', 'window_expired',
  'runtime_active', 'http_failed', 'read_only_refused', 'account_refused', 'workspace_refused', 'response_invalid',
  'resource_changed', 'old_run_changed', 'signout_failed', 'budget_exhausted', 'preflight_failed'])
export const publicFailure = error => ({ code: CODES.has(error?.code) ? error.code : 'preflight_failed' })
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

/** The timeout stays attached to the body, not just response headers. */
async function deadlineFetch(fetchImpl, url, init, signal, timeoutMs, register = () => () => {}) {
  signal?.throwIfAborted()
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason ?? budgetError())
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(budgetError()), timeoutMs)
  let finished = false, unregister = () => {}
  const finish = () => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); unregister() }
  unregister = register(() => { controller.abort(budgetError()); finish() })
  let response
  try { response = await abortable(controller.signal, () => fetchImpl(url, { ...init, signal: controller.signal }), value => value.body?.cancel()) }
  catch (error) { finish(); throw error }
  if (!response.body) { finish(); return response }
  const reader = response.body.getReader(); let output
  const bodyAbort = () => {
    if (finished) return
    output.error(controller.signal.reason ?? budgetError()); reader.cancel().catch(() => {}); done()
  }
  const done = () => { controller.signal.removeEventListener('abort', bodyAbort); finish() }
  const body = new ReadableStream({
    start(value) { output = value; controller.signal.addEventListener('abort', bodyAbort, { once: true }); if (controller.signal.aborted) bodyAbort() },
    async pull(value) {
      try { const item = await reader.read(); if (finished) return
        if (item.done) { value.close(); done() } else value.enqueue(item.value)
      } catch (error) { if (!finished) { value.error(error); done() } }
    },
    cancel(reason) { done(); reader.cancel(reason).catch(() => {}) },
  }, { highWaterMark: 0 })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

// Fill only after actual main is served and root registers the short account
// window. Owned Bot IDs must come from this batch's real creation receipts.
// Empty ownedBotIds is a valid inventory run and reports a missing fixture Bot.
export const BINDING = Object.freeze({
  "applicationSha": "1c7698655405b289d7fdbd814713d15e542cc2bb",
  "opsParentSha": "c47f71d7f60d3f490d8006a07dec164ecf71cea6",
  "workspaceId": "de300001-ece6-4021-8214-c986ea306bde",
  "readerSha256": "b823ba1c5729768b1da5c3615aba91ac39723bd4c54e9f382b3ed1368d58ec6e",
  "policyAdminSha256": "b86765f1f6d3a988ed566b140747d124985d558b179d9a0732516cf6d189ae28",
  "ownedBotIds": [],
  "windowCommentId": 6753115982,
  "windowStartsAt": "2026-11-09T22:25:34.000Z",
  "windowExpiresAt": "2026-11-09T22:37:34.000Z",
  "windowCommentBodySha256": "e1dc237bdd387e7483f32bd9d64b5941133537245a6cd598cb8340ab2678c3fa"
})

export function checkBinding(binding = BINDING) {
  check(exact(binding, Object.keys(BINDING)) && SHA.test(binding.applicationSha ?? '') && SHA.test(binding.opsParentSha ?? '')
    && UUID.test(binding.workspaceId ?? '')
    && ['readerSha256', 'policyAdminSha256', 'windowCommentBodySha256'].every(key => DIGEST.test(binding[key] ?? ''))
    && Array.isArray(binding.ownedBotIds) && binding.ownedBotIds.length <= 5 && binding.ownedBotIds.every(id => UUID.test(id))
    && new Set(binding.ownedBotIds).size === binding.ownedBotIds.length && positive(binding.windowCommentId)
    && iso(binding.windowStartsAt) && iso(binding.windowExpiresAt)
    && Date.parse(binding.windowExpiresAt) > Date.parse(binding.windowStartsAt)
    && Date.parse(binding.windowExpiresAt) - Date.parse(binding.windowStartsAt) <= 20 * 60000, 'binding_refused')
  return binding
}

export function guardContext(env, event, checkout, dirty, parents, binding = BINDING) {
  workflowGuard(env); checkBinding(binding)
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_WORKFLOW_REF === `${REPO}/${PATH}@refs/heads/${BRANCH}`
    && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_TRIGGERING_ACTOR === 'alexj11324'
    && env.GITHUB_JOB === 'publication_preflight' && SHA.test(env.GITHUB_SHA ?? '')
    && event.repository?.id === 1427517699 && event.repository?.owner?.id === 183887963
    && event.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA && event.before === binding.opsParentSha
    && isDeepStrictEqual(parents, [binding.opsParentSha]) && event.forced === false
    && event.deleted === false && checkout === env.GITHUB_SHA && !dirty, 'source_refused')
}

export function windowRecord(binding) {
  return { state: 'active', batch: 1782, mode: 'read_only_publication_preflight', mainSha: binding.applicationSha,
    workspaceSha256: hash(binding.workspaceId), opsParentSha: binding.opsParentSha,
    startsAt: binding.windowStartsAt, expiresAt: binding.windowExpiresAt }
}
async function boundedJson(response, limit = 1024 * 1024, signal) {
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); check(false, 'http_failed') }
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    for (;;) { signal?.throwIfAborted(); const { value, done } = await reader.read(); signal?.throwIfAborted(); if (done) break
      size += value.length; if (size > limit) { await reader.cancel(); check(false, 'http_failed') }; chunks.push(value) }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks)) } catch { check(false, 'response_invalid') }
}

export async function guardMain(env, binding = BINDING, fetchImpl = fetch, now = Date.now, minimumRemainingMs = 0, signal, register) {
  checkBinding(binding)
  const clock = typeof now === 'function' ? now : () => now
  const checkTime = () => { const at = clock(); signal?.throwIfAborted()
    check(at >= Date.parse(binding.windowStartsAt) && at + minimumRemainingMs < Date.parse(binding.windowExpiresAt), 'window_expired'); return at }
  checkTime()
  check(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0, 'source_refused')
  const github = async path => {
    const result = await boundedJson(await deadlineFetch(fetchImpl, API + path, { redirect: 'error',
      headers: { authorization: 'Bearer ' + env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'cache-control': 'no-store' } }, signal, 15000, register), 1024 * 1024, signal)
    checkTime(); return result
  }
  const main = await github('/git/ref/heads/main')
  check(main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === binding.applicationSha, 'main_changed')
  const version = await boundedJson(await deadlineFetch(fetchImpl, ORIGIN + '/mikka/api/version?verify=1782-publication-preflight-' + checkTime(),
    { headers: { 'cache-control': 'no-store' }, redirect: 'error' }, signal, 15000, register), 8192, signal)
  checkTime()
  check(version.build === binding.applicationSha, 'build_changed')
  const issue = await github('/issues/1752')
  check(issue.number === 1752 && positive(issue.comments), 'window_changed')
  const comments = await github('/issues/1752/comments?per_page=1&page=' + issue.comments)
  const comment = comments?.[0]
  check(Array.isArray(comments) && comments.length === 1 && comment.id === binding.windowCommentId
    && comment.issue_url === API + '/issues/1752' && comment.user?.login === 'alexj11324' && comment.user.id === 183887963
    && typeof comment.body === 'string' && hash(comment.body) === binding.windowCommentBodySha256, 'window_changed')
  const marker = '<!-- mikka-1782-publication-preflight:v1\n', start = comment.body.indexOf(marker)
  const end = comment.body.indexOf('\n-->', start)
  check(start >= 0 && end > start && comment.body.indexOf(marker, start + marker.length) === -1, 'window_changed')
  let record
  try { record = JSON.parse(comment.body.slice(start + marker.length, end)) } catch { check(false, 'window_changed') }
  check(isDeepStrictEqual(record, windowRecord(binding)), 'window_changed')
  // The reusable template builder cannot publish; the official main workflow can.
  // Query each live status so an old queued run cannot be hidden by a recent page.
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const runs = await github('/actions/workflows/e2b-official-runtime.yml/runs?branch=main&status=' + status + '&per_page=1')
    check(Number.isSafeInteger(runs.total_count) && runs.total_count >= 0 && Array.isArray(runs.workflow_runs), 'response_invalid')
    check(runs.total_count === 0 && runs.workflow_runs.length === 0, 'runtime_active')
  }
  return { mainSha: binding.applicationSha, servedBuild: version.build, opsParentSha: binding.opsParentSha, checkedAt: new Date(checkTime()).toISOString(),
    windowCommentId: binding.windowCommentId, officialRuntimeIdle: true }
}

/** This transport rejects every model, Task, settings, GitHub or Workspace write.
 * The two session lifecycle POSTs and registered read RPCs are the only POSTs. */
export function assertReadRequest(url, init, binding) {
  const target = new URL(url), method = init.method ?? 'GET', p = target.pathname
  check(target.origin === ORIGIN && p.startsWith('/mikka/'), 'read_only_refused')
  if (method === 'GET') {
    const reads = new Set(['/mikka/api/auth/get-session', '/mikka/api/workspace', '/mikka/api/integrations/github',
      '/mikka/api/integrations/github/repositories/verification', '/mikka/api/factory/agent-profiles', '/mikka/api/settings/api-keys',
      ...binding.ownedBotIds.map(id => '/mikka/api/bots/' + id)])
    check(reads.has(p), 'read_only_refused')
    const query = Object.fromEntries(target.searchParams)
    check(target.searchParams.size === Object.keys(query).length, 'read_only_refused')
    const expected = p === '/mikka/api/workspace' ? { workspace: binding.workspaceId }
      : p === '/mikka/api/factory/agent-profiles' ? { workspaceId: binding.workspaceId, location: 'cloud' }
      : p === '/mikka/api/settings/api-keys' ? { workspace: binding.workspaceId }
      : p === '/mikka/api/integrations/github/repositories/verification' ? { repository: REPOSITORY } : {}
    check(isDeepStrictEqual(query, expected), 'read_only_refused'); return
  }
  check(method === 'POST' && typeof init.body === 'string', 'read_only_refused')
  let body; try { body = JSON.parse(init.body) } catch { check(false, 'read_only_refused') }
  if (p === '/mikka/api/auth/sign-in/email') {
    check(exact(body, ['email', 'password', 'rememberMe']) && body.rememberMe === false, 'read_only_refused'); return
  }
  if (p === '/mikka/api/auth/sign-out') { check(exact(body, []), 'read_only_refused'); return }
  check(p === '/mikka/api/rpc' && exact(body, ['version', 'action', 'args']) && body.version === 1 && Array.isArray(body.args), 'read_only_refused')
  const a = body.args
  const allowed = ['bots.pollBots', 'task-runs.pollThreads'].includes(body.action) && a.length === 0
    || body.action === 'model-order.getModelOrder' && isDeepStrictEqual(a, [binding.workspaceId])
    || body.action === 'execution-settings.getBotModelMenu' && a.length === 1
      && (a[0] === null || binding.ownedBotIds.includes(a[0]))
    || body.action === 'coordinator.pollCoordinatorChat' && a.length === 1 && binding.ownedBotIds.includes(a[0])
    || ['issues.getIssue', 'issue-operations.getDeletedIssue'].includes(body.action) && a.length === 1 && UUID.test(a[0])
  check(allowed, 'read_only_refused')
  check(new Headers(init.headers).get('x-mikka-workspace-id') === binding.workspaceId, 'read_only_refused')
}

export async function authorize(client, email, binding = BINDING) {
  const session = await client.json('/api/auth/get-session'), ownerId = session?.user?.id
  check(typeof ownerId === 'string' && hash(ownerId) === binding.readerSha256
    && session.user.email?.trim().toLowerCase() === email.trim().toLowerCase(), 'account_refused')
  const view = await client.json('/api/workspace?workspace=' + binding.workspaceId)
  check(view.currentUserId === ownerId && view.workspace?.id === binding.workspaceId && view.workspace.kind === 'team'
    && ['member', 'admin'].includes(view.role) && Array.isArray(view.choices) && Array.isArray(view.members), 'workspace_refused')
  const own = view.members.filter(row => row.userId === ownerId)
  const admin = view.members.filter(row => typeof row.userId === 'string' && hash(row.userId) === binding.policyAdminSha256
    && row.role === 'admin' && row.status === 'active')
  check(view.choices.filter(row => row.id === binding.workspaceId && row.kind === 'team').length === 1
    && own.length === 1 && own[0].status === 'active' && own[0].role === view.role
    && admin.length === 1 && admin[0].userId !== ownerId, 'workspace_refused')
  return { ownerId, adminId: admin[0].userId, workspaceId: binding.workspaceId, workspaceKind: 'team' }
}

const official = row => row && Object.hasOwn(MODELS, row.harness) && row.model === MODELS[row.harness]
  && row.source?.kind === 'subscription' && UUID.test(row.source.connectionId)
const sameSource = (a, b) => a.harness === b.harness && a.model === b.model && a.source.connectionId === b.source.connectionId
const safeAvailability = value => value?.available === true ? 'available' : value?.available === false ? 'unavailable' : 'unknown'

/** Two normal API observations, not a direct menu-to-connection identity claim.
 * The menu exposes a public owner name, while the order exposes owner/connection
 * IDs. Correlate only if the whole matching model directory and public name are
 * unique. A missing or ambiguous choice cannot authorize a setup mutation. */
export function sharedClaudeChoice(order, menu, workspace, scope) {
  check(Array.isArray(order?.candidates) && order.candidates.length <= 1000
    && Array.isArray(menu?.groups) && menu.groups.length <= 100
    && menu.groups.every(group => Array.isArray(group?.options) && group.options.length <= 1000)
    && workspace?.currentUserId === scope.ownerId && workspace.workspace?.id === scope.workspaceId
    && workspace.workspace.kind === 'team' && Array.isArray(workspace.members), 'response_invalid')
  const admin = workspace.members.filter(row => row.userId === scope.adminId && row.role === 'admin' && row.status === 'active')
  check(admin.length === 1, 'workspace_refused')
  const name = admin[0].name
  const orderMatches = order.candidates.filter(row => row.model === MODELS.claude_code)
  const menuMatches = menu.groups.flatMap(group => group.options
    .filter(option => option.modelId === MODELS.claude_code).map(option => ({ group, option })))
  const named = typeof name === 'string' && name.trim().length > 0 && name.length <= 256
  const nameMatches = named ? workspace.members.filter(row => row.status === 'active' && row.name === name).length : 0
  const counts = { orderCandidates: orderMatches.length, menuOptions: menuMatches.length, activeMembersWithAdminName: nameMatches }
  const absent = orderMatches.length === 0 || menuMatches.length === 0
  if (absent) return { status: 'unavailable', reason: 'missing_matching_directory_entry', counts }
  if (orderMatches.length !== 1 || menuMatches.length !== 1 || nameMatches !== 1)
    return { status: 'unproven', reason: 'ambiguous_model_or_public_owner_name', counts }
  const source = orderMatches[0], { group, option } = menuMatches[0]
  if (source.harness !== 'claude_code' || source.source?.kind !== 'subscription'
    || source.credentialOwnerId !== scope.adminId || !UUID.test(source.source.connectionId)
    || group.kind !== 'subscription' || group.provider !== 'claude' || group.owner !== name
    || option.provider !== 'claude' || !UUID.test(option.id))
    return { status: 'unproven', reason: 'shared_source_or_public_owner_mismatch', counts }
  return { status: 'correlated_unique_directories', counts,
    orderObservation: { harness: 'claude_code', model: MODELS.claude_code, kind: 'subscription',
      connectionId: source.source.connectionId, credentialOwnerSha256: hash(source.credentialOwnerId) },
    menuObservation: { readTarget: 'workspace_coordinator', choiceId: option.id, provider: 'claude',
      modelId: option.modelId, kind: group.kind, sharedOwnerNameSha256: hash(name) },
    limitation: 'menu_does_not_expose_connection_or_owner_ids; revalidate_both_directories_on_new_owned_bot_before_selecting' }
}

export async function inventory(client, scope, binding = BINDING, now = Date.now()) {
  const requests = [client.json('/api/integrations/github'),
    client.json('/api/factory/agent-profiles?workspaceId=' + scope.workspaceId + '&location=cloud'),
    client.rpc('model-order.getModelOrder', [scope.workspaceId]), client.rpc('bots.pollBots', []),
    client.json('/api/settings/api-keys?workspace=' + scope.workspaceId),
    client.rpc('execution-settings.getBotModelMenu', [null]),
    client.json('/api/workspace?workspace=' + scope.workspaceId)]
  const settled = await Promise.allSettled(requests)
  const failed = settled.find(row => row.status === 'rejected'); if (failed) throw failed.reason
  const [github, management, order, bots, keys, coordinatorMenu, workspace] = settled.map(row => row.value)
  const claudeChatChoice = sharedClaudeChoice(order, coordinatorMenu, workspace, scope)
  check(github.viewerId === scope.ownerId && Array.isArray(github.repositories) && github.repositories.length <= 1000
    && Array.isArray(management.profiles) && management.profiles.length < 101 && management.availability
    && Array.isArray(management.catalog?.models) && Array.isArray(order.candidates) && order.candidates.length <= 1000
    && typeof order.cloudReady === 'boolean' && ['local', 'cloud'].includes(order.location)
    && Array.isArray(bots.items) && bots.items.length <= 1000
    && bots.live?.ownerId === scope.ownerId && bots.live.workspaceId === scope.workspaceId
    && Array.isArray(keys.keys) && keys.keys.length <= 1000 && typeof keys.apiKeyAfterQuota === 'boolean', 'response_invalid')
  check(bots.items.every(row => UUID.test(row.id)) && new Set(bots.items.map(row => row.id)).size === bots.items.length
    && keys.keys.every(key => ['anthropic', 'openai', 'deepseek', 'kimi', 'custom'].includes(key.provider)
      && ['anthropic', 'openai'].includes(key.protocol) && Array.isArray(key.models)
      && key.models.every(value => typeof value === 'string')), 'response_invalid')
  const repos = github.repositories.filter(row => row.fullName?.toLowerCase() === REPOSITORY.toLowerCase())
  check(repos.length <= 1, 'response_invalid')
  const repositoryAvailable = github.connected === true && github.installed === true && repos.length === 1
  let verification = { configured: false, commandSha256: null }
  if (repositoryAvailable) {
    const value = await client.json('/api/integrations/github/repositories/verification?repository=' + encodeURIComponent(REPOSITORY))
    check(value.viewerId === scope.ownerId && value.repository?.toLowerCase() === REPOSITORY.toLowerCase()
      && (value.verifyCommand === null || typeof value.verifyCommand === 'string' && value.verifyCommand.length <= 2000), 'response_invalid')
    verification = { configured: Boolean(value.verifyCommand), commandSha256: value.verifyCommand === null ? null : hash(value.verifyCommand) }
  }
  const sources = order.candidates.filter(row => official(row) && row.credentialOwnerId === scope.adminId)
  const sourceKeys = sources.map(row => JSON.stringify([row.harness, row.model, row.source.connectionId]))
  check(new Set(sourceKeys).size === sourceKeys.length, 'response_invalid')
  const summaries = management.profiles.map(row => {
    check(UUID.test(row.id) && positive(row.version) && DIGEST.test(row.digest) && typeof row.enabled === 'boolean'
      && typeof row.instructions === 'string' && row.instructions.length <= 24000 && Array.isArray(row.skills)
      && row.skills.length <= 12 && row.skills.every(value => typeof value === 'string'), 'response_invalid')
    const approved = row.model?.mode === 'fixed' && official(row.model) && sources.some(source => sameSource(row.model, source))
      && (row.harness === 'auto' || row.harness === row.model.harness)
    return { id: row.id, version: row.version, digest: row.digest, enabled: row.enabled && !row.archivedAt,
      officialFixedSource: approved, availability: safeAvailability(management.availability[row.id]),
      ...(approved ? { harness: row.model.harness, model: row.model.model, connectionId: row.model.source.connectionId } : {}),
      instructionsPresent: row.instructions.trim().length > 0, instructionsSha256: hash(row.instructions), skillsCount: row.skills.length,
      definitionNeedsReview: row.instructions.trim().length > 0 || row.skills.length > 0 }
  })
  check(new Set(summaries.map(row => row.id)).size === summaries.length, 'response_invalid')
  const reviewBounded = summaries.filter(row => row.enabled).every(row => row.officialFixedSource)
  const approvedModels = new Set(Object.values(MODELS))
  const apiKeyFallbackReachable = keys.apiKeyAfterQuota && keys.keys.some(key => (key.provider !== 'custom' || key.protocol === 'openai')
    && key.models.some(model => approvedModels.has(model)))
  const ownedBots = []
  for (const botId of binding.ownedBotIds) {
    if (!bots.items.some(row => row.id === botId)) { ownedBots.push({ id: botId, present: false }); continue }
    const bot = await client.json('/api/bots/' + botId)
    check(bot.id === botId, 'resource_changed')
    const chat = await client.rpc('coordinator.pollCoordinatorChat', [botId])
    const menu = await client.rpc('execution-settings.getBotModelMenu', [botId])
    check(chat.botId === botId && typeof chat.enabled === 'boolean' && typeof chat.working === 'boolean', 'response_invalid')
    const current = menu.current, harness = current?.provider === 'claude' ? 'claude_code' : current?.provider
    const approved = current?.kind === 'subscription' && current.chosen === true && !current.fallback
      && Object.hasOwn(MODELS, harness ?? '') && current.modelId === MODELS[harness]
      && (current.available === true || current.availability === 'checking')
    ownedBots.push({ id: botId, present: true, idle: chat.enabled && !chat.working && !chat.streamRunId,
      officialChatSelected: approved, ...(approved ? { harness, model: current.modelId } : {}) })
  }
  // Freeze a few genuine old Run references before any future new Task exists.
  // The normal list is own-actor + same request Workspace; each Task still gets
  // an independent ordinary detail ACL read. Never emit list prompt/reply text.
  const threads = await client.rpc('task-runs.pollThreads', [])
  check(Array.isArray(threads?.items) && threads.items.length <= 200 && threads.unchanged !== true && threads.delta !== true
    && threads.items.every(row => UUID.test(row.id) && (row.issueId === null || UUID.test(row.issueId))
      && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt))
      && Date.parse(row.createdAt) > now - 30 * 86400000 && Date.parse(row.createdAt) <= now + 60000)
    && new Set(threads.items.map(row => row.id)).size === threads.items.length, 'response_invalid')
  const old = [], seen = new Set()
  for (const row of threads.items) if (row.issueId && TERMINAL.has(row.status) && !seen.has(row.issueId)) {
    seen.add(row.issueId); if (old.length === 3) break
    const access = await readHistoryTaskAccess(client, scope, row.issueId)
    old.push({ taskId: row.issueId, runId: row.id, createdAt: row.createdAt, observedAt: new Date(now).toISOString(), observedStatus: row.status,
      creatorSha256: hash(access.creator), accessMode: access.mode,
      deletedAtSha256: access.deletedAt === null ? null : hash(access.deletedAt) })
  }
  const blockers = []
  if (!repositoryAvailable) blockers.push('repository_not_available')
  if (!sources.length) blockers.push('approved_shared_subscription_missing')
  // The ordinary preference view reports false when its saved location is
  // local. That is not proof the explicitly requested cloud target is absent.
  if (!order.cloudReady) blockers.push(order.location === 'cloud' ? 'cloud_not_ready' : 'explicit_cloud_readiness_unproven')
  if (!ownedBots.some(row => row.present && row.idle && row.officialChatSelected)) blockers.push('owned_idle_official_bot_missing')
  if (!summaries.some(row => row.enabled && row.officialFixedSource && row.availability === 'available' && !row.definitionNeedsReview)) blockers.push('writable_profile_requires_review_or_creation')
  if (!reviewBounded) blockers.push('automatic_review_source_unbounded')
  if (apiKeyFallbackReachable) blockers.push('approved_chat_api_key_fallback_reachable')
  if (!old.length) blockers.push('authorized_old_run_missing')
  return { repository: { fullName: REPOSITORY, authorized: repositoryAvailable, verification, githubWriteCapability: 'requires_real_run_push_and_server_pr' },
    sources: sources.map(row => ({ harness: row.harness, model: row.model, connectionId: row.source.connectionId,
      catalogAvailability: safeAvailability(management.catalog.models.find(value => official(value) && sameSource(value, row))) })),
    profiles: summaries, botCount: bots.items.length, ownedBots, claudeChatChoice, defaultLocation: order.location, cloudReady: order.cloudReady,
    automaticReviewSourcesBounded: reviewBounded, apiKeyFallbackReachable, oldRunCandidates: old,
    oldRunWindow: { returned: threads.items.length, cap: 200, days: 30, selected: old.length, capReached: threads.items.length === 200 },
    blockers, configurationReady: blockers.length === 0 }
}

export async function capture(client, env, binding = BINDING, pin = () => guardMain(env, binding), now = Date.now) {
  const { email, password } = smokeAcceptanceAccount(env)
  const report = { version: 1, issue: 1687, batch: 1782, mode: 'read_only_publication_preflight', status: 'failed',
    mainSha: binding.applicationSha, opsSource: env.GITHUB_SHA, opsParentSha: binding.opsParentSha, runId: env.GITHUB_RUN_ID, runAttempt: 1,
    workspaceId: binding.workspaceId, readerSha256: binding.readerSha256, policyAdminSha256: binding.policyAdminSha256,
    startedAt: new Date(now()).toISOString(), phase: 'source', cleanup: { signedOut: false },
    limitations: ['no_model_submitted', 'no_explicit_task_or_configuration_mutation', 'normal_coordinator_initialization_and_catalogue_maintenance_not_measured',
      'not_a_publication_or_before_snapshot', 'profile_instructions_need_review_before_writable_execution',
      'old_run_candidates_require_exact_APP_recheck_in_before_transaction'] }
  let signedIn = false
  try {
    report.before = await pin()
    report.phase = 'sign_in'
    signedIn = true
    const login = await client.request('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))
    check(login.ok, 'account_refused')
    report.phase = 'authorization'
    const scope = await authorize(client, email, binding)
    report.phase = 'inventory'
    report.inventory = await inventory(client, scope, binding, now())
    report.phase = 'reauthorization'
    const afterScope = await authorize(client, email, binding)
    check(isDeepStrictEqual(afterScope, scope), 'resource_changed')
    for (const old of report.inventory.oldRunCandidates) {
      const access = await readHistoryTaskAccess(client, scope, old.taskId)
      check(hash(access.creator) === old.creatorSha256, 'old_run_changed')
    }
    report.phase = 'source_after'; report.after = await pin()
    report.phase = 'complete'
    report.status = report.inventory.configurationReady ? 'preflight_ready' : 'preflight_blocked'
  } catch (error) { report.failure = publicFailure(error); report.status = 'failed' }
  finally {
    if (signedIn) {
      try { check((await client.request('/api/auth/sign-out', post({}))).ok, 'signout_failed'); report.cleanup.signedOut = true }
      catch { report.failure ??= { code: 'signout_failed' }; report.status = 'failed' }
    }
    client.clear(); report.completedAt = new Date(now()).toISOString()
  }
  return report
}

/** Shared entry for the real check/capture commands and offline transport
 * tests. The work clock starts before the first source request and is never
 * restarted by a pin. Signout has its own ten-second signal. */
export async function executePreflight(operation, env, binding = BINDING, { fetchImpl = fetch, now = Date.now,
  workMs = 110000, signoutMs = 10000 } = {}) {
  check(['check', 'capture'].includes(operation) && typeof now === 'function'
    && positive(workMs) && workMs <= 110000 && positive(signoutMs) && signoutMs <= 10000, 'binding_refused')
  const work = new AbortController(), leases = new Set(), startedAt = now()
  const workTimer = setTimeout(() => work.abort(budgetError()), workMs)
  let signout, signoutTimer, report
  const register = close => { leases.add(close); return () => leases.delete(close) }
  const signoutSignal = () => {
    if (!signout) { signout = new AbortController(); signoutTimer = setTimeout(() => signout.abort(budgetError()), signoutMs) }
    return signout.signal
  }
  const pin = () => guardMain(env, binding, fetchImpl, now, 0, work.signal, register)
  try {
    await guardMain(env, binding, fetchImpl, now, 180000, work.signal, register)
    if (operation === 'check') return { mode: 'read_only_publication_preflight', sourceVerified: true }
    const session = createSessionClient(ORIGIN, (url, init) => {
      const signingOut = url.pathname === '/mikka/api/auth/sign-out'
      const prepared = { ...init, headers: { ...init.headers, 'x-mikka-workspace-id': binding.workspaceId } }
      assertReadRequest(url, prepared, binding)
      return deadlineFetch(fetchImpl, url, prepared, signingOut ? signoutSignal() : work.signal, signingOut ? signoutMs : 15000, register)
    })
    const prepare = (path, init = {}) => ({ ...init, signal: path === '/api/auth/sign-out' ? signoutSignal() : work.signal })
    const client = {
      request: (path, init, timeoutMs) => session.request(path, prepare(path, init), timeoutMs),
      json: (path, init, timeoutMs) => session.json(path, prepare(path, init), timeoutMs),
      async rpc(action, args, extra = {}) {
        const response = await client.json('/api/rpc', { ...post({ version: 1, action, args }),
          headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1', ...extra.headers } }, extra.timeoutMs)
        check(response.ok === true, 'read_only_refused'); const value = decodeWire(response.result)
        check(!value?.error && value?.ok !== false, 'read_only_refused')
        return value?.ok === true && 'data' in value ? value.data : value
      },
      clear: () => session.clear(),
    }
    report = await capture(client, env, binding, pin, now)
    return report
  } finally {
    work.abort(budgetError()); signout?.abort(budgetError())
    for (const close of leases) close()
    clearTimeout(workTimer); clearTimeout(signoutTimer)
    if (report) report.executionBudget = { workMs, signoutMs, startedAt: new Date(startedAt).toISOString(),
      workDeadline: new Date(startedAt + workMs).toISOString(), timersClosed: leases.size === 0 }
  }
}

async function main(operation) {
  check(['check', 'capture'].includes(operation), 'source_refused'); const env = process.env
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16384 }).trim()
  guardContext(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')), git('rev-parse', 'HEAD'),
    git('status', '--porcelain', '--untracked-files=all') !== '', git('show', '-s', '--format=%P', 'HEAD').split(' '))
  const report = await executePreflight(operation, env, BINDING)
  if (operation === 'check') { console.log(JSON.stringify(report)); return }
  report.sourceSha256 = hash(await readFile(new URL(import.meta.url)))
  const output = resolve(env.RUNNER_TEMP, 'publication-preflight-1782'); await mkdir(output, { recursive: true, mode: 0o700 })
  const bytes = JSON.stringify(report, null, 2) + '\n'
  const receipt = { mode: report.mode, status: report.status, mainSha: report.mainSha, opsSource: report.opsSource, opsParentSha: report.opsParentSha,
    runId: report.runId, runAttempt: 1, phase: report.phase, evidenceSha256: hash(bytes), cleanup: report.cleanup, executionBudget: report.executionBudget,
    blockers: report.inventory?.blockers ?? [], ...(report.failure ? { failure: report.failure } : {}) }
  await writeFile(resolve(output, 'preflight.json'), bytes, { mode: 0o600 })
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(receipt)); if (report.status !== 'preflight_ready') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(JSON.stringify(publicFailure(error))); process.exitCode = 1 })
}
