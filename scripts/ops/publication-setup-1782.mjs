/** One normal, owned Bot and (only if needed) one pure fixed Profile for #1782.
 * No Task, prompt, model execution, shared defaults, integration or DB access. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { workflowGuard } from './self-hosted-closeout.mjs'
import { authorize, sharedClaudeChoice } from './publication-preflight-1782.mjs'
import { createCaptureBudget } from './publication-fixture-1782.mjs'
import { createSessionClient, decodeWire, smokeAcceptanceAccount } from '../acceptance/cloud-startup.mjs'

const REPO = 'alexj11324/Mikka', BRANCH = 'ops/self-hosted-vault-closeout-20261108'
const API = 'https://api.github.com/repos/' + REPO, ORIGIN = 'https://app.aspectlylabs.com'
const WORKFLOW = '.github/workflows/issue1782-publication-setup.yml'
const PREFLIGHT = '.github/workflows/issue1782-publication-preflight.yml'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{40}$/, DIGEST = /^[0-9a-f]{64}$/
const ENDED = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const MODELS = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const positive = n => Number.isSafeInteger(n) && n > 0
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const post = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
const CODES = new Set(['binding_refused', 'source_refused', 'main_changed', 'build_changed', 'window_changed', 'window_expired',
  'runtime_active', 'preflight_refused', 'request_refused', 'http_failed', 'response_invalid', 'account_refused', 'workspace_refused',
  'resource_changed', 'existing_profile_requires_review', 'profile_reuse_required', 'profile_refused', 'bot_name_conflict',
  'bot_create_uncertain', 'bot_invalid', 'bot_busy', 'choice_refused', 'profile_create_uncertain', 'duplicate_mutation',
  'cleanup_unproven', 'signout_failed', 'budget_exhausted', 'setup_failed'])
export function publicFailure(error) {
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth++) if (CODES.has(e.code)) return { code: e.code }
  return { code: 'setup_failed' }
}

// Actual values are compiled only after a real normal preflight and a separate
// finite #1752 grant. There is no CLI/environment resource or model override.
export const BINDING = Object.freeze({ applicationSha: null, opsParentSha: null, workspaceId: null, readerSha256: null,
  policyAdminSha256: null, policyAdminNameSha256: null, subscriptionConnectionId: null, prechooseChoiceId: null,
  preflightRunId: null, preflightOpsSource: null, preflightStatus: null, preflightArtifactId: null,
  preflightArtifactSha256: null, preflightEvidenceSha256: null, preflightSourceSha256: null,
  botName: null, profileDecision: null, enabledProfilePins: null,
  windowCommentId: null, windowCommentBodySha256: null, windowStartsAt: null, windowExpiresAt: null })

export function checkBinding(b = BINDING) {
  check(exact(b, Object.keys(BINDING)) && ['applicationSha', 'opsParentSha', 'preflightOpsSource'].every(k => SHA.test(b[k] ?? ''))
    && ['workspaceId', 'subscriptionConnectionId', 'prechooseChoiceId'].every(k => UUID.test(b[k] ?? ''))
    && ['readerSha256', 'policyAdminSha256', 'policyAdminNameSha256', 'preflightArtifactSha256', 'preflightEvidenceSha256',
      'preflightSourceSha256', 'windowCommentBodySha256'].every(k => DIGEST.test(b[k] ?? ''))
    && ['preflightRunId', 'preflightArtifactId', 'windowCommentId'].every(k => positive(b[k]))
    && ['preflight_ready', 'preflight_blocked'].includes(b.preflightStatus)
    && typeof b.botName === 'string' && /^1782-[A-Za-z0-9][A-Za-z0-9 -]{0,54}$/.test(b.botName) && b.botName.trim() === b.botName
    && iso(b.windowStartsAt) && iso(b.windowExpiresAt) && Date.parse(b.windowExpiresAt) > Date.parse(b.windowStartsAt)
    && Date.parse(b.windowExpiresAt) - Date.parse(b.windowStartsAt) <= 20 * 60000, 'binding_refused')
  const d = b.profileDecision
  check(d?.mode === 'reuse' ? exact(d, ['mode', 'id', 'version', 'digest']) && UUID.test(d.id) && positive(d.version) && DIGEST.test(d.digest)
    : d?.mode === 'create' && exact(d, ['mode', 'requestId', 'name']) && UUID.test(d.requestId)
      && typeof d.name === 'string' && /^1782-[A-Za-z0-9][A-Za-z0-9 -]{0,74}$/.test(d.name) && d.name.trim() === d.name, 'binding_refused')
  check(Array.isArray(b.enabledProfilePins) && b.enabledProfilePins.length <= (d.mode === 'create' ? 99 : 100)
    && b.enabledProfilePins.every(p => exact(p, ['id', 'version', 'digest']) && UUID.test(p.id) && positive(p.version) && DIGEST.test(p.digest))
    && new Set(b.enabledProfilePins.map(p => p.id)).size === b.enabledProfilePins.length, 'binding_refused')
  return b
}

export function guardContext(env, event, checkout, parents, dirty, b = BINDING) {
  workflowGuard(env); checkBinding(b)
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_WORKFLOW_REF === `${REPO}/${WORKFLOW}@refs/heads/${BRANCH}`
    && env.GITHUB_JOB === 'publication_setup' && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_TRIGGERING_ACTOR === 'alexj11324'
    && SHA.test(env.GITHUB_SHA ?? '') && event.repository?.id === 1427517699 && event.repository?.owner?.id === 183887963
    && event.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA && event.before === b.opsParentSha
    && isDeepStrictEqual(parents, [b.opsParentSha]) && event.forced === false && event.deleted === false
    && checkout === env.GITHUB_SHA && dirty === false, 'source_refused')
}
export function windowRecord(b) {
  return { state: 'active', batch: 1782, mode: 'owned_publication_resource_setup', mainSha: b.applicationSha,
    workspaceSha256: hash(b.workspaceId), readerSha256: b.readerSha256, opsParentSha: b.opsParentSha,
    preflightRunId: b.preflightRunId, preflightEvidenceSha256: b.preflightEvidenceSha256,
    startsAt: b.windowStartsAt, expiresAt: b.windowExpiresAt }
}
export function createSetupBudget(b, { totalMs = 150000, cleanupReserveMs = 40000, signoutReserveMs = 10000, now = Date.now } = {}) {
  check(totalMs <= 150000 && cleanupReserveMs <= 40000 && signoutReserveMs <= 10000, 'binding_refused')
  return createCaptureBudget(b, { totalMs, cleanupReserveMs, signoutReserveMs, now })
}
async function boundedJSON(response, signal) {
  signal.throwIfAborted()
  check(response.body, 'response_invalid')
  const reader = response.body.getReader(), chunks = []; let size = 0
  const abort = () => { reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) { signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break
      size += value.length; check(size <= 1024 * 1024, 'response_invalid'); chunks.push(value) }
    try { return JSON.parse(Buffer.concat(chunks)) } catch { check(false, 'response_invalid') }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
async function signalFetch(fetchImpl, url, init, signal) {
  signal.throwIfAborted()
  const response = await fetchImpl(url, { ...init, signal })
  if (signal.aborted) { response.body?.cancel().catch(() => {}); signal.throwIfAborted() }
  return response
}
async function readFetch(url, init, fetchImpl, budget, phase = 'work') {
  return budget.run(phase, 15000, async signal => {
    const response = await signalFetch(fetchImpl, url, { ...init, redirect: 'error' }, signal)
    if (!response.ok) { await response.body?.cancel().catch(() => {}); check(false, 'http_failed') }
    return boundedJSON(response, signal)
  })
}
export async function guardMain(env, b, fetchImpl, budget, phase = 'work', minimumRemainingMs = 0) {
  checkBinding(b)
  const time = () => { const at = budget.now(); budget.remaining(phase)
    check(at >= Date.parse(b.windowStartsAt) && at + minimumRemainingMs < Date.parse(b.windowExpiresAt), 'window_expired'); return at }
  time(); check(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0, 'source_refused')
  const github = async path => { const data = await readFetch(API + path, { headers: { authorization: 'Bearer ' + env.GITHUB_TOKEN,
    accept: 'application/vnd.github+json', 'cache-control': 'no-store' } }, fetchImpl, budget, phase); time(); return data }
  const main = await github('/git/ref/heads/main')
  check(main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === b.applicationSha, 'main_changed')
  const version = await readFetch(ORIGIN + '/mikka/api/version?verify=1782-setup-' + time(), { headers: { 'cache-control': 'no-store' } }, fetchImpl, budget, phase)
  time(); check(version.build === b.applicationSha, 'build_changed')
  const issue = await github('/issues/1752'); check(issue.number === 1752 && positive(issue.comments), 'window_changed')
  const rows = await github('/issues/1752/comments?per_page=1&page=' + issue.comments), c = rows?.[0]
  check(Array.isArray(rows) && rows.length === 1 && c.id === b.windowCommentId && c.issue_url === API + '/issues/1752'
    && c.user?.id === 183887963 && c.user.login === 'alexj11324' && typeof c.body === 'string'
    && hash(c.body) === b.windowCommentBodySha256, 'window_changed')
  const marker = '<!-- mikka-1782-publication-setup:v1\n', start = c.body.indexOf(marker), end = c.body.indexOf('\n-->', start)
  check(start >= 0 && end > start && c.body.indexOf(marker, start + marker.length) === -1, 'window_changed')
  let record; try { record = JSON.parse(c.body.slice(start + marker.length, end)) } catch { check(false, 'window_changed') }
  check(isDeepStrictEqual(record, windowRecord(b)), 'window_changed')
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const runs = await github('/actions/workflows/e2b-official-runtime.yml/runs?branch=main&status=' + status + '&per_page=1')
    check(runs.total_count === 0 && Array.isArray(runs.workflow_runs) && runs.workflow_runs.length === 0, 'runtime_active')
  }
  return { mainSha: b.applicationSha, servedBuild: version.build, checkedAt: new Date(time()).toISOString(),
    windowCommentId: b.windowCommentId, officialRuntimeIdle: true }
}

export function validatePreflight(bytes, receipt, b) {
  check(Buffer.byteLength(bytes) <= 1024 * 1024 && hash(bytes) === b.preflightEvidenceSha256, 'preflight_refused')
  let p; try { p = JSON.parse(bytes) } catch { check(false, 'preflight_refused') }
  check(p.version === 1 && p.batch === 1782 && p.issue === 1687 && p.mode === 'read_only_publication_preflight'
    && p.status === b.preflightStatus && p.phase === 'complete' && p.runAttempt === 1
    && String(p.runId) === String(b.preflightRunId) && p.opsSource === b.preflightOpsSource
    && p.mainSha === b.applicationSha && p.workspaceId === b.workspaceId && p.readerSha256 === b.readerSha256
    && p.policyAdminSha256 === b.policyAdminSha256 && p.sourceSha256 === b.preflightSourceSha256
    && p.cleanup?.signedOut === true && p.executionBudget?.timersClosed === true
    && receipt.evidenceSha256 === b.preflightEvidenceSha256 && receipt.opsSource === b.preflightOpsSource
    && String(receipt.runId) === String(b.preflightRunId) && receipt.runAttempt === 1 && receipt.status === p.status
    && receipt.mainSha === b.applicationSha && receipt.cleanup?.signedOut === true, 'preflight_refused')
  const choice = p.inventory?.claudeChatChoice
  check(choice?.status === 'correlated_unique_directories' && choice.orderObservation?.connectionId === b.subscriptionConnectionId
    && choice.orderObservation.credentialOwnerSha256 === b.policyAdminSha256
    && choice.menuObservation?.choiceId === b.prechooseChoiceId && choice.menuObservation.sharedOwnerNameSha256 === b.policyAdminNameSha256
    && p.inventory.apiKeyFallbackReachable === false && p.inventory.automaticReviewSourcesBounded === true
    && Array.isArray(p.inventory.profiles) && Array.isArray(p.inventory.blockers), 'preflight_refused')
  const blockers = new Set(['repository_not_available', 'approved_shared_subscription_missing', 'cloud_not_ready',
    'explicit_cloud_readiness_unproven', 'owned_idle_official_bot_missing', 'writable_profile_requires_review_or_creation',
    'automatic_review_source_unbounded', 'approved_chat_api_key_fallback_reachable', 'authorized_old_run_missing'])
  check(p.inventory.blockers.every(code => blockers.has(code))
    && new Set(p.inventory.blockers).size === p.inventory.blockers.length
    && (p.status === 'preflight_ready' ? p.inventory.blockers.length === 0 && p.inventory.configurationReady === true
      : p.inventory.blockers.length > 0 && p.inventory.configurationReady === false), 'preflight_refused')
  const pins = p.inventory.profiles.filter(row => row.enabled).map(({ id, version, digest }) => ({ id, version, digest })).sort((a, z) => a.id.localeCompare(z.id))
  check(isDeepStrictEqual(pins, [...b.enabledProfilePins].sort((a, z) => a.id.localeCompare(z.id))), 'preflight_refused')
  return p
}
export async function verifyPreflightSource(env, b, fetchImpl, budget) {
  const get = path => readFetch(API + path, { headers: { authorization: 'Bearer ' + env.GITHUB_TOKEN,
    accept: 'application/vnd.github+json' } }, fetchImpl, budget)
  const run = await get('/actions/runs/' + b.preflightRunId)
  check(run.id === b.preflightRunId && run.run_attempt === 1 && run.head_sha === b.preflightOpsSource
    && run.head_branch === BRANCH && run.event === 'push' && run.path === PREFLIGHT && run.status === 'completed'
    && run.conclusion === (b.preflightStatus === 'preflight_ready' ? 'success' : 'failure')
    && run.repository?.id === 1427517699 && run.repository.full_name === REPO
    && run.actor?.login === 'alexj11324' && run.actor.id === 183887963, 'preflight_refused')
  const artifact = await get('/actions/artifacts/' + b.preflightArtifactId)
  check(artifact.id === b.preflightArtifactId && artifact.name === `publication-preflight-1782-${b.preflightRunId}-1`
    && artifact.expired === false && positive(artifact.size_in_bytes) && artifact.size_in_bytes <= 1024 * 1024
    && artifact.digest === 'sha256:' + b.preflightArtifactSha256 && artifact.workflow_run?.id === b.preflightRunId
    && artifact.workflow_run.head_sha === b.preflightOpsSource, 'preflight_refused')
  const source = await get('/contents/scripts/ops/publication-preflight-1782.mjs?ref=' + b.preflightOpsSource)
  check(source.type === 'file' && source.encoding === 'base64' && typeof source.content === 'string'
    && hash(Buffer.from(source.content, 'base64')) === b.preflightSourceSha256, 'preflight_refused')
  return { runId: b.preflightRunId, artifactId: b.preflightArtifactId, artifactSha256: b.preflightArtifactSha256,
    opsSource: b.preflightOpsSource, sourceSha256: b.preflightSourceSha256 }
}

export const newState = () => ({ botId: null, verifiedBotId: null, profileCreated: false, profilePostStarted: false,
  archiveAllowed: false, phase: 'read', mutations: new Set() })
export function profileDefinition(b) {
  return { name: b.profileDecision.name, description: '', roles: [], enabled: true, harness: 'claude_code',
    model: { mode: 'fixed', harness: 'claude_code', model: 'claude-haiku-5-5', source: { kind: 'subscription', connectionId: b.subscriptionConnectionId } },
    instructions: '', skills: [] }
}
const botInput = b => ({ name: b.botName, color: 'gris', shape: 'cercle', model: null, repository: null })
export function assertSetupRequest(url, init, b, state) {
  const u = new URL(url), method = init.method ?? 'GET', p = u.pathname, query = Object.fromEntries(u.searchParams)
  check(u.origin === ORIGIN && !u.username && !u.password && !u.hash && u.searchParams.size === Object.keys(query).length, 'request_refused')
  check(new Headers(init.headers).get('x-mikka-workspace-id') === b.workspaceId, 'request_refused')
  const profileId = b.profileDecision.mode === 'reuse' ? b.profileDecision.id : b.profileDecision.requestId
  if (method === 'GET') {
    const plain = p === '/mikka/api/auth/get-session' || state.botId && p === '/mikka/api/bots/' + state.botId
    const expected = p === '/mikka/api/workspace' ? { workspace: b.workspaceId }
      : p === '/mikka/api/factory/agent-profiles' ? { workspaceId: b.workspaceId, location: 'cloud' }
      : p === '/mikka/api/settings/api-keys' ? { workspace: b.workspaceId }
      : p === '/mikka/api/factory/agent-profiles/' + profileId ? { workspaceId: b.workspaceId } : plain ? {} : null
    check(expected && isDeepStrictEqual(query, expected), 'request_refused'); return
  }
  check(typeof init.body === 'string' && Buffer.byteLength(init.body) <= 8192 && Object.keys(query).length <= 1, 'request_refused')
  let body; try { body = JSON.parse(init.body) } catch { check(false, 'request_refused') }
  if (p === '/mikka/api/auth/sign-in/email') { check(method === 'POST' && Object.keys(query).length === 0
    && exact(body, ['email', 'password', 'rememberMe']) && body.rememberMe === false, 'request_refused'); return }
  if (p === '/mikka/api/auth/sign-out') { check(method === 'POST' && Object.keys(query).length === 0 && exact(body, []), 'request_refused'); return }
  let mutation
  if (p === '/mikka/api/factory/agent-profiles') {
    check(method === 'POST' && b.profileDecision.mode === 'create' && state.verifiedBotId
      && isDeepStrictEqual(body, { workspaceId: b.workspaceId, requestId: b.profileDecision.requestId, profile: profileDefinition(b) })
      && Object.keys(query).length === 0, 'request_refused'); mutation = 'profile_create'
  } else if (p === '/mikka/api/factory/agent-profiles/' + profileId) {
    check(method === 'DELETE' && b.profileDecision.mode === 'create' && state.profileCreated && state.archiveAllowed
      && isDeepStrictEqual(query, { workspaceId: b.workspaceId })
      && isDeepStrictEqual(body, { workspaceId: b.workspaceId, version: 1 }), 'request_refused'); mutation = 'profile_archive'
  } else {
    check(method === 'POST' && p === '/mikka/api/rpc' && Object.keys(query).length === 0
      && exact(body, ['version', 'action', 'args']) && body.version === 1 && Array.isArray(body.args), 'request_refused')
    const a = body.args
    if (body.action === 'bots.createBot') { check(isDeepStrictEqual(a, [botInput(b)]), 'request_refused'); mutation = 'bot_create' }
    else if (body.action === 'execution-settings.chooseBotModel') {
      check(state.verifiedBotId && isDeepStrictEqual(a, [state.verifiedBotId, b.prechooseChoiceId]), 'request_refused'); mutation = 'bot_choice'
    } else check((['bots.pollBots', 'task-runs.pollThreads'].includes(body.action) && a.length === 0)
      || (body.action === 'model-order.getModelOrder' && isDeepStrictEqual(a, [b.workspaceId]))
      || (body.action === 'execution-settings.getBotModelMenu' && a.length === 1 && (a[0] === null || state.verifiedBotId && a[0] === state.verifiedBotId))
      || (body.action === 'coordinator.pollCoordinatorChat' && state.verifiedBotId && isDeepStrictEqual(a, [state.verifiedBotId])), 'request_refused')
  }
  if (mutation) { check(!state.mutations.has(mutation), 'duplicate_mutation'); state.mutations.add(mutation) }
}

const CLIENTS = new WeakMap()
export function createSetupClient(b, state, budget, fetchImpl = fetch) {
  const session = createSessionClient(ORIGIN, (url, init) => {
    init.signal.throwIfAborted(); assertSetupRequest(url, init, b, state)
    return signalFetch(fetchImpl, url, init, init.signal)
  })
  const exchange = (path, init = {}) => budget.run(path === '/api/auth/sign-out' ? 'signout' : budget.phase, 15000, async signal => {
    const response = await session.request(path, { ...init, signal, headers: { ...init.headers, 'x-mikka-workspace-id': b.workspaceId } })
    return { status: response.status, body: await boundedJSON(response, signal) }
  })
  const client = { exchange, async json(path, init) {
    const value = await exchange(path, init); check(value.status >= 200 && value.status < 300 && !value.body?.error, 'http_failed'); return value.body
  }, async rpc(action, args) {
    const result = await client.json('/api/rpc', { ...post({ version: 1, action, args }), headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1' } })
    check(result.ok === true, 'request_refused'); const value = decodeWire(result.result)
    check(!value?.error && value?.ok !== false, 'request_refused'); return value?.ok === true && 'data' in value ? value.data : value
  }, clear: () => session.clear() }
  CLIENTS.set(client, budget); return client
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}
export const profileDigest = definition => hash(canonical({ definition, skills: [] }))
function definitionOf(p) {
  const { id: _id, version: _version, digest: _digest, createdAt: _created, updatedAt: _updated, archivedAt: _archived, ...definition } = p
  return definition
}
function pureProfile(p, connectionId) {
  const d = definitionOf(p)
  return UUID.test(p.id ?? '') && positive(p.version) && DIGEST.test(p.digest ?? '') && p.enabled === true && p.archivedAt === null
    && (p.harness === 'claude_code' || p.harness === 'auto') && p.model?.mode === 'fixed' && p.model.harness === 'claude_code'
    && p.model.model === 'claude-haiku-5-5' && isDeepStrictEqual(p.model.source, { kind: 'subscription', connectionId })
    && p.instructions === '' && Array.isArray(p.skills) && p.skills.length === 0 && Array.isArray(p.roles) && p.roles.length === 0
    && profileDigest(d) === p.digest
}
function profilePin(p) { return { id: p.id, version: p.version, digest: p.digest } }
function verifyChoice(value, b, requested = false) {
  check(value.status === 'correlated_unique_directories' && value.orderObservation.connectionId === b.subscriptionConnectionId
    && value.orderObservation.credentialOwnerSha256 === b.policyAdminSha256
    && value.menuObservation.sharedOwnerNameSha256 === b.policyAdminNameSha256
    && (!requested || value.menuObservation.choiceId === b.prechooseChoiceId), 'choice_refused')
  return value.menuObservation.choiceId
}
function selectedMenu(menu, choiceId) {
  check(menu.current?.id === choiceId && menu.current.kind === 'subscription' && menu.current.provider === 'claude'
    && menu.current.modelId === 'claude-haiku-5-5' && menu.current.chosen === true && !menu.current.fallback
    && (menu.current.available === true || menu.current.availability === 'checking'), 'choice_refused')
}
async function threadSet(client) {
  const value = await client.rpc('task-runs.pollThreads', [])
  check(Array.isArray(value?.items) && value.items.length < 200 && value.unchanged !== true && value.delta !== true
    && value.items.every(row => UUID.test(row.id) && ENDED.has(row.status))
    && new Set(value.items.map(row => row.id)).size === value.items.length, 'bot_busy')
  return { returned: value.items.length, days: 30, cap: 200, allReturnedEnded: true,
    sha256: hash(canonical(value.items.map(row => ({ id: row.id, status: row.status })).sort((a, z) => a.id.localeCompare(z.id)))) }
}
async function roster(client, scope) {
  const value = await client.rpc('bots.pollBots', [])
  check(value?.live?.ownerId === scope.ownerId && value.live.workspaceId === scope.workspaceId && Array.isArray(value.items)
    && value.items.length <= 1000 && value.items.every(row => UUID.test(row.id) && typeof row.name === 'string')
    && new Set(value.items.map(row => row.id)).size === value.items.length, 'resource_changed')
  return value.items
}
async function verifyBot(client, state, scope, b, initialIds) {
  const bots = await roster(client, scope), matches = bots.filter(row => row.name === b.botName && !initialIds.has(row.id))
  check(matches.length === 1 && (!state.botId || matches[0].id === state.botId), 'bot_invalid')
  state.botId = matches[0].id
  const bot = await client.json('/api/bots/' + state.botId)
  check(bot.id === state.botId && bot.name === b.botName && bot.color === 'gris' && bot.shape === 'cercle'
    && matches[0].color === 'gris' && matches[0].shape === 'cercle' && matches[0].coordinator !== true, 'bot_invalid')
  state.verifiedBotId = bot.id; return bot.id
}
async function idleBot(client, id, requireEnabled = true) {
  const chat = await client.rpc('coordinator.pollCoordinatorChat', [id])
  check(chat.botId === id && chat.working === false && !chat.streamRunId && (!requireEnabled || chat.enabled === true), 'bot_busy')
}
async function resources(client, scope, b) {
  const reads = await Promise.allSettled([client.rpc('model-order.getModelOrder', [b.workspaceId]),
    client.rpc('execution-settings.getBotModelMenu', [null]), client.json('/api/workspace?workspace=' + b.workspaceId),
    client.json('/api/factory/agent-profiles?workspaceId=' + b.workspaceId + '&location=cloud'),
    client.json('/api/settings/api-keys?workspace=' + b.workspaceId)])
  const failed = reads.find(row => row.status === 'rejected'); if (failed) throw failed.reason
  const [order, menu, workspace, management, keys] = reads.map(row => row.value)
  verifyChoice(sharedClaudeChoice(order, menu, workspace, scope), b, true)
  check(Array.isArray(keys.keys) && keys.keys.length <= 1000 && typeof keys.apiKeyAfterQuota === 'boolean'
    && keys.keys.every(key => ['anthropic', 'openai', 'deepseek', 'kimi', 'custom'].includes(key.provider)
      && ['anthropic', 'openai'].includes(key.protocol) && Array.isArray(key.models)
      && key.models.every(model => typeof model === 'string'))
    && !(keys.apiKeyAfterQuota && keys.keys.some(key => (key.provider !== 'custom' || key.protocol === 'openai')
      && key.models.some(model => Object.values(MODELS).includes(model)))), 'resource_changed')
  check(Array.isArray(management.profiles) && management.profiles.length < 101 && management.availability
    && Array.isArray(management.catalog?.models), 'response_invalid')
  const enabled = management.profiles.filter(p => p.enabled && !p.archivedAt)
  check(isDeepStrictEqual(enabled.map(profilePin).sort((a, z) => a.id.localeCompare(z.id)),
    [...b.enabledProfilePins].sort((a, z) => a.id.localeCompare(z.id))), 'resource_changed')
  for (const p of enabled) check(p.model?.mode === 'fixed' && MODELS[p.model.harness] === p.model.model
    && (p.harness === 'auto' || p.harness === p.model.harness) && p.model.source?.kind === 'subscription'
    && p.instructions === '' && p.skills?.length === 0 && Array.isArray(p.roles) && p.roles.length <= 12
    && profileDigest(definitionOf(p)) === p.digest
    && order.candidates.some(c => c.credentialOwnerId === scope.adminId && c.harness === p.model.harness && c.model === p.model.model
      && c.source?.kind === 'subscription' && c.source.connectionId === p.model.source.connectionId), 'existing_profile_requires_review')
  const eligible = enabled.filter(p => pureProfile(p, b.subscriptionConnectionId) && management.availability[p.id]?.available === true)
  if (b.profileDecision.mode === 'reuse') check(eligible.some(p => isDeepStrictEqual(profilePin(p),
    { id: b.profileDecision.id, version: b.profileDecision.version, digest: b.profileDecision.digest })), 'profile_refused')
  else check(eligible.length === 0 && !management.profiles.some(p => p.id === b.profileDecision.requestId), 'profile_reuse_required')
  check(management.catalog.models.some(p => p.harness === 'claude_code' && p.model === 'claude-haiku-5-5'
    && p.source?.kind === 'subscription' && p.source.connectionId === b.subscriptionConnectionId && p.available === true), 'resource_changed')
  return { order, workspace }
}

export async function capture(client, env, b, state, preflight, { budget, pin } = {}) {
  checkBinding(b); check(CLIENTS.get(client) === budget && typeof pin === 'function', 'binding_refused')
  const { email, password } = smokeAcceptanceAccount(env)
  const report = { version: 1, batch: 1782, mode: 'owned_publication_resource_setup', status: 'failed', phase: 'source',
    mainSha: b.applicationSha, opsSource: env.GITHUB_SHA, opsParentSha: b.opsParentSha, runId: env.GITHUB_RUN_ID, runAttempt: 1,
    workspaceId: b.workspaceId, readerSha256: b.readerSha256, policyAdminSha256: b.policyAdminSha256,
    preflight: { runId: b.preflightRunId, artifactId: b.preflightArtifactId, artifactSha256: b.preflightArtifactSha256,
      evidenceSha256: b.preflightEvidenceSha256, sourceSha256: b.preflightSourceSha256, opsSource: b.preflightOpsSource },
    record: {}, cleanup: { signedOut: false, botDeleteSupported: false, botRetained: false, profileArchived: false },
    limits: { tasksSubmitted: 0, modelsInvoked: 0, globalDefaultsChanged: false, freshReadyPreflightRequired: true },
    startedAt: new Date(budget.now()).toISOString() }
  let signedIn = false, scope, initialIds = new Set(), oldThreads
  try {
    report.before = await pin('work'); report.phase = 'sign_in'; signedIn = true
    check((await client.exchange('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))).status === 200, 'account_refused')
    scope = await authorize(client, email, b); report.phase = 'resources'
    const dirs = await resources(client, scope, b), bots = await roster(client, scope)
    check(!bots.some(bot => bot.name === b.botName), 'bot_name_conflict'); initialIds = new Set(bots.map(bot => bot.id))
    oldThreads = await threadSet(client)
    report.activityBefore = oldThreads
    report.phase = 'create_bot'; await pin('work')
    try {
      const bot = await client.rpc('bots.createBot', [botInput(b)])
      if (UUID.test(bot?.id)) { state.botId = bot.id; report.record.botId = bot.id }
      check(bot?.name === b.botName && bot.color === 'gris' && bot.shape === 'cercle' && state.botId, 'bot_invalid')
    } catch (error) { if (!state.botId) throw Object.assign(new Error('bot_create_uncertain'), { code: 'bot_create_uncertain', cause: error }); throw error }
    report.record.botId = await verifyBot(client, state, scope, b, initialIds)
    await idleBot(client, state.verifiedBotId, false)
    report.phase = 'choose_model'
    const menu = await client.rpc('execution-settings.getBotModelMenu', [state.verifiedBotId])
    verifyChoice(sharedClaudeChoice(dirs.order, menu, dirs.workspace, scope), b, true)
    await pin('work')
    const chosen = await client.rpc('execution-settings.chooseBotModel', [state.verifiedBotId, b.prechooseChoiceId])
    const ackId = verifyChoice(sharedClaudeChoice(dirs.order, chosen, dirs.workspace, scope), b); selectedMenu(chosen, ackId)
    const afterReads = await Promise.allSettled([
      client.rpc('model-order.getModelOrder', [b.workspaceId]), client.json('/api/workspace?workspace=' + b.workspaceId),
      client.rpc('execution-settings.getBotModelMenu', [state.verifiedBotId])])
    const afterFailed = afterReads.find(row => row.status === 'rejected'); if (afterFailed) throw afterFailed.reason
    const [afterOrder, afterWorkspace, afterMenu] = afterReads.map(row => row.value)
    const observedChoice = sharedClaudeChoice(afterOrder, afterMenu, afterWorkspace, scope)
    const selectedId = verifyChoice(observedChoice, b); selectedMenu(afterMenu, selectedId)
    await idleBot(client, state.verifiedBotId)
    report.record.choice = { requestedId: b.prechooseChoiceId, acknowledgedId: ackId, selectedId, deduplicated: selectedId !== b.prechooseChoiceId,
      connectionId: b.subscriptionConnectionId, provider: 'claude', model: 'claude-haiku-5-5',
      sourceCorrelation: { ...observedChoice, menuObservation: { ...observedChoice.menuObservation, readTarget: 'new_owned_bot' } } }
    report.phase = 'profile'
    let profile
    if (b.profileDecision.mode === 'reuse') profile = (await client.json('/api/factory/agent-profiles/' + b.profileDecision.id + '?workspaceId=' + b.workspaceId)).profile
    else {
      await pin('work'); state.profilePostStarted = true; report.record.proposedProfileId = b.profileDecision.requestId
      let created
      try { created = await client.exchange('/api/factory/agent-profiles', post({ workspaceId: b.workspaceId,
        requestId: b.profileDecision.requestId, profile: profileDefinition(b) })) }
      catch (cause) { throw Object.assign(new Error('profile_create_uncertain'), { code: 'profile_create_uncertain', cause }) }
      check(created.status === 201 && created.body?.profile?.id === b.profileDecision.requestId, 'profile_refused')
      profile = created.body.profile
      check(profile.version === 1 && isDeepStrictEqual(definitionOf(profile), profileDefinition(b))
        && pureProfile(profile, b.subscriptionConnectionId), 'profile_refused')
      state.profileCreated = true; report.record.profile = { ...profilePin(profile), created: true }
      const readback = (await client.json('/api/factory/agent-profiles/' + profile.id + '?workspaceId=' + b.workspaceId)).profile
      check(isDeepStrictEqual(readback, profile), 'profile_refused')
    }
    check(pureProfile(profile, b.subscriptionConnectionId), 'profile_refused')
    if (b.profileDecision.mode === 'reuse') check(isDeepStrictEqual(profilePin(profile),
      { id: b.profileDecision.id, version: b.profileDecision.version, digest: b.profileDecision.digest }), 'profile_refused')
    report.record.profile = { ...profilePin(profile), created: state.profileCreated }
    const management = await client.json('/api/factory/agent-profiles?workspaceId=' + b.workspaceId + '&location=cloud')
    check(management.availability?.[profile.id]?.available === true && management.profiles?.some(row => isDeepStrictEqual(profilePin(row), profilePin(profile))), 'profile_refused')
    const expectedPins = [...b.enabledProfilePins, ...(state.profileCreated ? [profilePin(profile)] : [])].sort((a, z) => a.id.localeCompare(z.id))
    check(isDeepStrictEqual(management.profiles.filter(p => p.enabled && !p.archivedAt).map(profilePin).sort((a, z) => a.id.localeCompare(z.id)), expectedPins), 'resource_changed')
    check(isDeepStrictEqual(await authorize(client, email, b), scope), 'resource_changed')
    await verifyBot(client, state, scope, b, initialIds); await idleBot(client, state.verifiedBotId)
    const finalThreads = await threadSet(client); check(isDeepStrictEqual(finalThreads, oldThreads), 'resource_changed')
    report.activityAfter = finalThreads
    report.after = await pin('work'); report.status = 'setup_ready'; report.phase = 'complete'
    report.remainingPreflightBlockers = preflight.inventory.blockers.filter(code => !['owned_idle_official_bot_missing', 'writable_profile_requires_review_or_creation'].includes(code))
  } catch (error) { report.failure = publicFailure(error) }
  finally {
    budget.enterCleanup()
    if (scope && state.mutations.has('bot_create')) {
      try { report.record.botId = await verifyBot(client, state, scope, b, initialIds); await idleBot(client, state.verifiedBotId, false); report.cleanup.botIdleConfirmed = true }
      catch (error) { report.cleanup.botReadbackFailure = publicFailure(error); report.failure ??= publicFailure(error); report.status = 'failed' }
    }
    report.cleanup.botRetained = Boolean(state.botId)
    report.cleanup.botOwnershipVerified = Boolean(state.verifiedBotId)
    report.cleanup.botRetentionUnresolved = state.mutations.has('bot_create') && !state.verifiedBotId
    if (report.status !== 'setup_ready' && state.profileCreated) {
      try {
        check(isDeepStrictEqual(await authorize(client, email, b), scope), 'cleanup_unproven')
        const currentThreads = await threadSet(client); check(isDeepStrictEqual(currentThreads, oldThreads), 'cleanup_unproven')
        report.cleanup.activityBeforeArchive = currentThreads
        await idleBot(client, state.verifiedBotId, false); await pin('cleanup')
        const id = b.profileDecision.requestId, before = (await client.json('/api/factory/agent-profiles/' + id + '?workspaceId=' + b.workspaceId)).profile
        check(before.id === id && before.version === 1 && pureProfile(before, b.subscriptionConnectionId)
          && isDeepStrictEqual(definitionOf(before), profileDefinition(b)), 'cleanup_unproven')
        state.archiveAllowed = true
        const archived = await client.json('/api/factory/agent-profiles/' + id + '?workspaceId=' + b.workspaceId,
          { ...post({ workspaceId: b.workspaceId, version: 1 }), method: 'DELETE' })
        const actual = (await client.json('/api/factory/agent-profiles/' + id + '?workspaceId=' + b.workspaceId)).profile
        check(actual.id === id && actual.version === 2 && actual.enabled === false && iso(actual.archivedAt)
          && isDeepStrictEqual(archived.profile, actual)
          && isDeepStrictEqual(definitionOf(actual), { ...profileDefinition(b), enabled: false })
          && actual.digest === profileDigest(definitionOf(actual)), 'cleanup_unproven')
        report.cleanup.profileArchived = true; report.cleanup.archivedProfile = profilePin(actual)
      } catch (error) { report.cleanup.profileArchiveFailure = publicFailure(error) }
    }
    report.cleanup.profileRetained = Boolean(state.profileCreated && !report.cleanup.profileArchived)
    if (state.profilePostStarted && !state.profileCreated) report.cleanup.profileCreationUncertain = true
    budget.enterSignout()
    if (signedIn) try { check((await client.exchange('/api/auth/sign-out', post({}))).status === 200, 'signout_failed'); report.cleanup.signedOut = true }
    catch { report.failure ??= { code: 'signout_failed' }; report.status = 'failed' }
    client.clear(); report.completedAt = new Date(budget.now()).toISOString()
  }
  return report
}

async function loadEvidence(env, b) {
  const dir = resolve(env.RUNNER_TEMP, 'publication-setup-preflight')
  check(isDeepStrictEqual((await readdir(dir)).sort(), ['preflight.json', 'receipt.json']), 'preflight_refused')
  for (const name of ['preflight.json', 'receipt.json']) {
    const stat = await lstat(resolve(dir, name)); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 'preflight_refused')
  }
  return validatePreflight(await readFile(resolve(dir, 'preflight.json')), JSON.parse(await readFile(resolve(dir, 'receipt.json'), 'utf8')), b)
}
export async function executeSetup(operation, env, b = BINDING, { fetchImpl = fetch, evidence, budgetOptions } = {}) {
  check(['check', 'verify', 'capture'].includes(operation), 'source_refused'); checkBinding(b)
  const budget = createSetupBudget(b, budgetOptions); let report
  try {
    await guardMain(env, b, fetchImpl, budget, 'work', 180000)
    const source = await verifyPreflightSource(env, b, fetchImpl, budget)
    if (operation === 'check') return { verified: true, preflightRunId: b.preflightRunId, preflightArtifactId: b.preflightArtifactId }
    const preflight = evidence ? validatePreflight(evidence.bytes, evidence.receipt, b) : await loadEvidence(env, b)
    if (operation === 'verify') return { verified: true, ...source }
    const state = newState(), client = createSetupClient(b, state, budget, fetchImpl)
    report = await capture(client, env, b, state, preflight, { budget,
      pin: phase => guardMain(env, b, fetchImpl, budget, phase) })
    return report
  } finally { budget.dispose(); if (report) report.executionBudget = { ...budget.summary(), timersClosed: budget.activeTimers === 0 } }
}
async function main(operation) {
  const env = process.env, git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16384 }).trim()
  guardContext(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')), git('rev-parse', 'HEAD'),
    git('show', '-s', '--format=%P', 'HEAD').split(' '), git('status', '--porcelain', '--untracked-files=all') !== '')
  const report = await executeSetup(operation, env)
  if (operation !== 'capture') {
    if (operation === 'check' && env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT,
      `preflight_run=${BINDING.preflightRunId}\npreflight_artifact=${BINDING.preflightArtifactId}\n`)
    console.log(JSON.stringify(report)); return
  }
  report.sourceSha256 = hash(await readFile(new URL(import.meta.url)))
  const output = resolve(env.RUNNER_TEMP, 'publication-setup-1782'); await mkdir(output, { recursive: true, mode: 0o700 })
  const bytes = JSON.stringify(report, null, 2) + '\n'
  const receipt = { mode: report.mode, status: report.status, mainSha: report.mainSha, opsSource: report.opsSource,
    runId: report.runId, runAttempt: 1, evidenceSha256: hash(bytes), phase: report.phase, cleanup: report.cleanup,
    ...(report.failure ? { failure: report.failure } : {}), record: report.record }
  await writeFile(resolve(output, 'setup.json'), bytes, { mode: 0o600 })
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(receipt)); if (report.status !== 'setup_ready') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv[2]).catch(error => { console.error(JSON.stringify(publicFailure(error))); process.exitCode = 1 })
