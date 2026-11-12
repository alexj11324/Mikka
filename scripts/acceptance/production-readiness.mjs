#!/usr/bin/env node
/** Normal production sign-in and metadata reads only. No task, model or Settings writes. */
import { readRendererActions } from '../../lib/renderer-actions.mjs'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import {
  CASES, ORIGIN, REPOSITORY, successfulRelease, publicFailure as acceptanceFailure,
} from './project-decisions.mjs'
import { assertWorkspaceIdle, caseOrderPlan, orderFingerprint, ownedSource } from './model-provider-fallback.mjs'
import { publishedActions } from './read-action-transport.mjs'
import { DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { isValidDeploymentId } from '../../lib/deployment-id.mjs'

export const ACCEPTANCE_BRANCH = 'refs/heads/acceptance/proactive-1157-1163'
export const READINESS_ACTIONS = Object.freeze(['saveIssue', 'getIssueThread', 'changeModelOrder'])
// Prospective task actions only. Discovery never grants an HTTP write capability.
const readinessRpcActions = Object.freeze({ saveIssue: 'issues.saveIssue', getIssueThread: 'agents.getIssueThread',
  changeModelOrder: 'model-order.changeModelOrder' })
const PAGES = ['/en', '/en/settings?section=models']
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const accountId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const codes = new Set(['trigger_rejected', 'plan_invalid', 'deployment_proof', 'build_mismatch', 'web_deploy',
  'worker_release', 'attestation_required', 'account_required', 'request_denied', 'request_failed', 'http_refused',
  'sign_in_failed', 'session_missing', 'session_identity', 'workspace_missing', 'response_invalid',
  'action_missing', 'order_changed', 'source_checking', 'session_close_failed', 'readiness_timeout', 'readiness_failed'])
export class ReadinessError extends Error {
  constructor(code, httpStatus) { super(codes.has(code) ? code : 'readiness_failed'); this.httpStatus = httpStatus }
}
const check = (value, code, status) => { if (!value) throw new ReadinessError(code, status) }
export function publicFailure(error) {
  if (!(error instanceof ReadinessError)) return acceptanceFailure(error)
  return { status: 'blocked', code: error.message,
    ...(Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}) }
}

/** The existing acceptance branch has a proven OIDC route. No arbitrary branch, PR or active mode. */
export function triggerGuard(env, event, plan) {
  check(env.GITHUB_REPOSITORY === REPOSITORY && event?.repository?.full_name === REPOSITORY
    && sha(env.GITHUB_SHA), 'trigger_rejected')
  check(plan?.purpose === 'production-readiness' && plan.mode === 'readonly', 'plan_invalid')
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  if (manual) check(env.GITHUB_REF === 'refs/heads/main' && !event.inputs?.mode, 'trigger_rejected')
  else check(env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === ACCEPTANCE_BRANCH
    && event.ref === ACCEPTANCE_BRANCH && event.after === env.GITHUB_SHA && event.deleted !== true, 'trigger_rejected')
  const applicationSha = manual ? event.inputs?.application_sha : plan.applicationSha
  check(sha(applicationSha), 'plan_invalid')
  return { applicationSha, driverRevision: env.GITHUB_SHA, mode: 'readonly' }
}

/** A successful hash-comparison workflow may have skipped both publication jobs. */
export function runtimePublicationProof(worker, jobs, applicationSha) {
  if (!worker) return { status: 'unproven', code: 'release_missing', sourceCommit: null, workerSha: null }
  const base = { runId: worker.id, sourceCommit: null, workerSha: null }
  if (!Array.isArray(jobs)) return { ...base, status: 'unproven', code: 'jobs_unavailable' }
  const matching = name => jobs.filter(job => job?.name === name && job.run_id === worker.id)
  const [validate] = matching('validate'), [publish] = matching('publish')
  if (matching('validate').length !== 1 || matching('publish').length !== 1)
    return { ...base, status: 'unproven', code: 'jobs_unavailable' }
  if (validate.conclusion === 'skipped' || publish.conclusion === 'skipped')
    return { ...base, status: 'not_published', code: 'publish_skipped' }
  const completed = (job, stepName) => job.status === 'completed' && job.conclusion === 'success'
    && Number.isSafeInteger(job.id) && job.id > 0 && job.steps?.filter(step => step.name === stepName
      && step.status === 'completed' && step.conclusion === 'success').length === 1
  if (!completed(validate, 'Validate new official instances without template mutation')
    || !completed(publish, 'Publish the verified official runtime pair'))
    return { ...base, status: 'unproven', code: 'publish_unproven' }
  // This workflow verifies sourceCommit==GITHUB_SHA before publish and passes
  // that SHA as MIKKA_CLOUD_WORKER_SOURCE_COMMIT. The content hash is different;
  // it is not exposed by the jobs API and must never be invented from app SHA.
  return { ...base, status: 'published', sourceCommit: applicationSha, sourceEvidence: 'verified_publish_step',
    validateJobId: validate.id, publishJobId: publish.id }
}

/** Public Web identity is required before credentials. Runtime proof stays separate from read-only metadata. */
export async function attestReadiness({ env = process.env, event, plan, fetchImpl = fetch, now = Date.now } = {}) {
  const guard = triggerGuard(env, event, plan)
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'deployment_proof')
  async function read(url, github = false) {
    let response
    try { response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { accept: 'application/json', 'cache-control': 'no-store', ...(github ? { authorization: 'Bearer ' + env.GH_TOKEN } : {}) } }) }
    catch { throw new ReadinessError('deployment_proof') }
    check(response.ok, 'deployment_proof')
    const value = await response.json().catch(() => null)
    check(value !== null, 'deployment_proof')
    return value
  }
  const pin = async () => check((await read(ORIGIN + '/mikka/api/version')).build === guard.applicationSha, 'build_mismatch')
  await pin()
  const runs = await read('https://api.github.com/repos/' + REPOSITORY + '/actions/runs?head_sha=' + guard.applicationSha + '&per_page=100', true)
  const web = successfulRelease(runs.workflow_runs, guard.applicationSha, 'web')
  const worker = successfulRelease(runs.workflow_runs, guard.applicationSha, 'worker')
  check(web, 'web_deploy')
  let jobs
  if (worker) {
    try { jobs = (await read('https://api.github.com/repos/' + REPOSITORY + '/actions/runs/' + worker.id + '/jobs?filter=latest&per_page=100', true)).jobs }
    catch { /* A metadata-only check cannot promote an unavailable worker proof to execution readiness. */ }
  }
  const runtime = runtimePublicationProof(worker, jobs, guard.applicationSha)
  await pin()
  return { purpose: 'production-readiness', status: runtime.status === 'published' ? 'ready' : 'partial',
    repository: REPOSITORY, ...guard, metadataReadAuthorized: true, executionReady: false,
    webDeployRunId: web.id, runtime,
    checkedAt: new Date(now()).toISOString() }
}

const prefix = '/mikka/_next/static/chunks/'
// The same five-argument Next reference grammar as the production project driver;
// this runner has its own three-name allowlist and never invokes an action.
const identifier = String.raw`[$A-Z_a-z][$\w]*`
const member = identifier + String.raw`(?:\s*(?:\.\s*` + identifier
  + String.raw`|\[\s*(?:"` + identifier + String.raw`"|'` + identifier + String.raw`')\s*\]))*`
const referenceCall = new RegExp(
  String.raw`(?:\bcreateServerReference|\[\s*(?:"createServerReference"|'createServerReference')\s*\])\s*\)?\s*\(\s*(["'])([a-f0-9]{40,64})\1\s*,\s*`
  + member + String.raw`\s*,\s*(?:void\s+0|undefined)\s*,\s*` + member
  + String.raw`\s*,\s*(["'])([A-Za-z]+)\3\s*\)`, 'g')
function publicChunk(value) {
  try {
    const raw = value.startsWith('static/chunks/') ? '/mikka/_next/' + value : value
    const url = new URL(raw, ORIGIN)
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || !url.pathname.startsWith(prefix)) return null
    const path = raw.split(/[?#]/, 1)[0]
    const parts = /(?:^|\/)static\/chunks\/(.+\.js)$/.exec(path)?.[1].split('/').map(decodeURIComponent)
    if (!parts?.length || parts.some(part => !part || part === '.' || part === '..' || /[/\\]/.test(part))) return null
    return prefix + parts.map(encodeURIComponent).join('/') + url.search
  } catch { return null }
}

/** Only the public production skew pin is understood; never arbitrary query data. */
function webDeploymentPin(url) {
  if (!url.search) return ''
  const entries = [...url.searchParams]
  return entries.length === 1 && entries[0][0] === 'dpl' && isValidDeploymentId(entries[0][1]) ? entries[0][1] : null
}
function publicWebEntry(value) {
  try {
    const url = new URL(value, ORIGIN)
    if (value.includes('\\') || url.origin !== ORIGIN || url.username || url.password || url.hash
      || !/^\/mikka\/assets\/[A-Za-z0-9_-]+\.js$/.test(url.pathname)) return null
    return webDeploymentPin(url)
  } catch { return null }
}

/** A strict HTTP allowlist makes this runner incapable of dispatching or changing preferences. */
export function requestAllowed(url, method) {
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) return false
  const path = url.pathname, search = url.search
  if (method === 'POST') return !search && ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'].includes(path)
  if (method !== 'GET') return false
  if (['/mikka/api/version', '/mikka/api/auth/get-session', '/mikka/api/bots', '/mikka/api/settings/workspace-bots',
    '/mikka/api/mobile/threads', '/mikka/en'].includes(path)) return !search
  if (path === '/mikka/en/settings') return search === '?section=models'
  if (['/mikka/renderer-manifest.json', '/mikka/renderer-actions.json'].includes(path)) return webDeploymentPin(url) !== null
  if (['/mikka/api/settings/model-order', '/mikka/api/settings/api-keys', '/mikka/api/subscriptions'].includes(path))
    return [...url.searchParams.keys()].length === 1 && url.searchParams.has('workspace') && uuid(url.searchParams.get('workspace'))
  return publicChunk(url.toString()) !== null
}

/** Discover three already-published prospective task actions; never invoke them. */
export async function discoverReadinessActions(request) {
  const found = {}, queued = new Set(), visited = new Set(), queue = [], vitePins = new Set()
  const diagnostics = { required: [...READINESS_ACTIONS], found: [], missing: [], pagesRead: 0, pagesFailed: 0,
    chunksRead: 0, chunksFailed: 0, chunksRemaining: 0 }
  const add = value => { const path = publicChunk(value); if (path && !queued.has(path) && queued.size < 3000) { queued.add(path); queue.push(path) } }
  const scan = text => {
    for (const match of text.matchAll(referenceCall)) if (READINESS_ACTIONS.includes(match[4])) found[match[4]] = match[2]
    for (const match of text.matchAll(/(?:src|href)\s*=\s*(["'])([^"']+\.js(?:\?[^"']*)?)\1/g)) {
      const path = match[2].replaceAll('&amp;', '&'), pin = publicWebEntry(path)
      if (pin !== null) vitePins.add(pin)
      add(path)
    }
    for (const match of text.matchAll(/(["'])((?:static\/chunks\/|\/mikka\/_next\/static\/chunks\/)[^"'\\\r\n]+\.js(?:\?[^"'\\\r\n]*)?)\1/g)) add(match[2])
  }
  const read = async (path, kind) => {
    try {
      const response = await request(path)
      check(response.ok, 'http_refused')
      const text = await response.text()
      check(text.length <= 8_000_000, 'response_invalid')
      diagnostics[kind + 'Read']++; scan(text)
    } catch { diagnostics[kind + 'Failed']++ }
  }
  for (const page of PAGES) await read(page, 'pages')
  if (vitePins.size) {
    // A Vite document uses the published RPC inventory, never old Flight
    // references that happen to be present in an asset or a failed response.
    for (const name of READINESS_ACTIONS) delete found[name]
    Object.assign(diagnostics, { transport: 'rpc', rpcVersion: DESKTOP_RPC_VERSION, manifestsRead: 0, manifestsFailed: 0 })
    try {
      check(vitePins.size === 1, 'response_invalid')
      const [pin] = vitePins
      const response = await readRendererActions(request, '/mikka', pin)
      check(response.ok && response.headers.get('content-type')?.includes('application/json'), 'http_refused')
      const text = await response.text()
      check(Buffer.byteLength(text) <= 8_000_000, 'response_invalid')
      const manifest = JSON.parse(text), published = publishedActions(manifest), discovered = {}
      check(/^[a-f0-9]{64}$/.test(manifest.rendererBuild ?? '')
        && manifest.modules && typeof manifest.modules === 'object' && !Array.isArray(manifest.modules), 'response_invalid')
      for (const [name, action] of Object.entries(readinessRpcActions)) {
        if (!published.has(action)) continue
        const [module, exported] = action.split('.')
        check(Object.hasOwn(manifest.modules, module) && Array.isArray(manifest.modules[module])
          && manifest.modules[module].filter(value => value === exported).length === 1, 'response_invalid')
        discovered[name] = action
      }
      Object.assign(found, discovered)
      diagnostics.manifestsRead++
      diagnostics.rendererBuild = manifest.rendererBuild
      diagnostics.manifestSha256 = digest(text)
    } catch { diagnostics.manifestsFailed++ }
  } else while (queue.length && visited.size < 200 && READINESS_ACTIONS.some(name => !found[name])) {
    const batch = queue.splice(0, Math.min(20, 200 - visited.size))
    for (const path of batch) visited.add(path)
    await Promise.all(batch.map(path => read(path, 'chunks')))
  }
  diagnostics.found = READINESS_ACTIONS.filter(name => found[name])
  diagnostics.missing = READINESS_ACTIONS.filter(name => !found[name])
  diagnostics.chunksRemaining = queue.length
  return diagnostics
}

function activityView(workspace, own) {
  check(Array.isArray(workspace?.bots) && workspace.bots.every(bot => uuid(bot?.id)
    && ['idle', 'running'].includes(bot.status) && Number.isSafeInteger(bot.runningThreads) && bot.runningThreads >= 0), 'response_invalid')
  check(Array.isArray(own?.threads) && own.threads.every(thread => ['running', 'waiting', 'paused', 'failed', 'done', 'stopped'].includes(thread?.status)), 'response_invalid')
  return { scope: 'current_workspace_bot_runs_and_owner_mobile_thread_list',
    workspaceBots: workspace.bots.length, unfinishedWorkspaceBotRuns: workspace.bots.reduce((sum, bot) => sum + bot.runningThreads, 0),
    ownThreadsReturned: own.threads.length, activeOwnThreadsReturned: own.threads.filter(thread => ['running', 'waiting', 'paused'].includes(thread.status)).length,
    allProjectIdleVerified: false, runtimeLeasesVerified: false }
}

export async function runReadiness({ env = process.env, event, plan, attestation, fetchImpl = fetch, now = Date.now } = {}) {
  const guard = triggerGuard(env, event, plan)
  const age = now() - Date.parse(attestation?.checkedAt)
  check(attestation?.purpose === 'production-readiness' && ['ready', 'partial'].includes(attestation.status) && attestation.repository === REPOSITORY
    && attestation.mode === 'readonly' && attestation.applicationSha === guard.applicationSha
    && attestation.driverRevision === guard.driverRevision && attestation.metadataReadAuthorized === true && attestation.executionReady === false
    && Number.isSafeInteger(attestation.webDeployRunId) && attestation.webDeployRunId > 0
    && ['published', 'not_published', 'unproven'].includes(attestation.runtime?.status)
    && attestation.runtime.workerSha === null
    && (attestation.runtime.status === 'published' ? attestation.runtime.sourceCommit === guard.applicationSha
      && attestation.runtime.sourceEvidence === 'verified_publish_step' && Number.isSafeInteger(attestation.runtime.runId) && attestation.runtime.runId > 0
      && [attestation.runtime.validateJobId, attestation.runtime.publishJobId].every(id => Number.isSafeInteger(id) && id > 0)
      : attestation.runtime.sourceCommit === null && ['release_missing', 'jobs_unavailable', 'publish_skipped', 'publish_unproven'].includes(attestation.runtime.code)
      && (attestation.runtime.runId === undefined || Number.isSafeInteger(attestation.runtime.runId) && attestation.runtime.runId > 0))
    && attestation.status === (attestation.runtime.status === 'published' ? 'ready' : 'partial')
    && Number.isFinite(age) && age >= 0 && age <= 300000, 'attestation_required')
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  check(isSmokeAccountEmail(email) && typeof password === 'string' && password.length > 0, 'account_required')
  const runtime = { status: attestation.runtime.status, sourceCommit: attestation.runtime.sourceCommit, workerSha: null,
    ...(attestation.runtime.runId ? { runId: attestation.runtime.runId } : {}),
    ...(attestation.runtime.status === 'published' ? { sourceEvidence: 'verified_publish_step',
      validateJobId: attestation.runtime.validateJobId, publishJobId: attestation.runtime.publishJobId } : { code: attestation.runtime.code }) }
  const report = { purpose: 'production-readiness', ...guard, status: 'running', startedAt: new Date(now()).toISOString(),
    webDeployRunId: attestation.webDeployRunId, runtime,
    taskState: 'not_requested', taskCreationRequests: 0, preferenceMutationRequests: 0, modelCalls: 0,
    backendMaintenanceWritesMeasured: false, paidExecutionVerified: false, executionReady: false,
    cases: [], normalSessionObserved: false, sessionClosed: false }
  let cookie = '', ownerId, workspaceId
  const deadline = now() + 300000
  async function request(path, body) {
    const url = new URL(path.startsWith('/mikka/') ? path : '/mikka' + path, ORIGIN)
    const method = body === undefined ? 'GET' : 'POST'
    check(requestAllowed(url, method), 'request_denied')
    const logout = url.pathname === '/mikka/api/auth/sign-out'
    check(logout || now() < deadline, 'readiness_timeout')
    try { return await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(logout ? 30000 : Math.max(1, Math.min(30000, deadline - now()))),
      headers: { origin: ORIGIN, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
    catch { throw new ReadinessError('request_failed') }
  }
  async function json(path) {
    const response = await request(path), value = await response.json().catch(() => null)
    check(response.ok && value !== null && !value?.error, 'http_refused', response.status)
    return value
  }
  const pin = async () => check((await json('/api/version')).build === guard.applicationSha, 'build_mismatch')
  const botsScope = bots => check(Array.isArray(bots) && bots.length > 0
    && bots.every(bot => bot.ownerId === ownerId && bot.workspaceId === (workspaceId ?? bots[0].workspaceId))
    && uuid(bots[0].workspaceId), 'workspace_missing')
  try {
    await pin()
    const login = await request('/api/auth/sign-in/email', { email, password })
    check(login.ok, 'sign_in_failed')
    cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    check(cookie.length > 0, 'session_missing')
    const session = await json('/api/auth/get-session')
    check(session?.user?.email?.toLowerCase() === email.toLowerCase() && accountId(session.user.id), 'session_identity')
    ownerId = session.user.id
    report.normalSessionObserved = true
    const bots = await json('/api/bots'); botsScope(bots); workspaceId = bots[0].workspaceId
    report.scope = { ownerId, workspaceId, normalSession: true, existingOwnerBots: bots.length }
    const originalOrder = await json('/api/settings/model-order?workspace=' + workspaceId)
    check(Array.isArray(originalOrder.entries) && typeof originalOrder.customized === 'boolean', 'response_invalid')
    const before = orderFingerprint(originalOrder)
    report.order = { beforeSha256: digest(before), entries: originalOrder.entries.length, customized: originalOrder.customized }
    // Each credential route is independent. An API metadata/balance blocker never skips either subscription.
    for (const item of CASES) {
      const result = { case: item.id, model: item.model, harness: item.harness, credentialType: item.kind, taskState: 'not_requested' }
      try {
        await pin()
        const keys = item.kind === 'api_key' ? await json('/api/settings/api-keys?workspace=' + workspaceId) : { keys: [] }
        const connections = item.kind === 'subscription' ? await json('/api/subscriptions?workspace=' + workspaceId) : { connections: [] }
        const source = ownedSource(item, { order: originalOrder, keys, connections, ownerId })
        const sourceId = item.kind === 'api_key' ? source.source.keyId : source.source.connectionId
        check(uuid(sourceId), 'response_invalid')
        Object.assign(result, { source: { kind: item.kind, id: sourceId }, ownSource: true,
          cloudReady: true, reportedAvailabilityOnly: true })
        const currentEntry = originalOrder.entries.find(entry => entry.harness === item.harness && entry.model === item.model
          && (item.kind === 'api_key' ? entry.source?.keyId : entry.source?.connectionId) === sourceId)
        check(currentEntry?.block?.reason !== 'checking', 'source_checking')
        const single = caseOrderPlan(originalOrder, [source], ownerId)
        Object.assign(result, { status: 'ready', singleSourceAlreadySelected: single.already })
      } catch (error) { Object.assign(result, publicFailure(error)) }
      report.cases.push(result)
    }
    const workspace = await json('/api/settings/workspace-bots'), own = await json('/api/mobile/threads')
    report.activity = activityView(workspace, own)
    try {
      await assertWorkspaceIdle(async path => path === '/api/settings/workspace-bots' ? workspace : own)
      report.activity.status = 'idle'
    } catch (error) { Object.assign(report.activity, publicFailure(error)) }
    report.actionDiscovery = await discoverReadinessActions(request)
    const current = await json('/api/settings/model-order?workspace=' + workspaceId)
    const after = orderFingerprint(current)
    Object.assign(report.order, { afterSha256: digest(after), unchanged: after === before })
    check(after === before, 'order_changed')
    botsScope(await json('/api/bots'))
    await pin()
    report.metadataStatus = report.cases.every(item => item.status === 'ready') && report.activity.status === 'idle'
      && !report.actionDiscovery.missing.length ? 'ready' : 'partial'
    report.status = report.metadataStatus === 'ready' && report.runtime.status === 'published' ? 'ready' : 'partial'
  } catch (error) {
    Object.assign(report, publicFailure(error))
    if (!report.cases.length) report.cases = CASES.map(item => ({ case: item.id, model: item.model, credentialType: item.kind,
      taskState: 'not_requested', ...publicFailure(error) }))
  } finally {
    if (cookie) report.sessionClosed = await request('/api/auth/sign-out', {}).then(response => response.ok).catch(() => false)
    cookie = ''
    if (report.scope && !report.sessionClosed) { report.status = 'blocked'; report.code = 'session_close_failed' }
    report.finishedAt = new Date(now()).toISOString()
  }
  return report
}

async function output(name, report) {
  await mkdir('production-readiness-report', { recursive: true })
  await writeFile('production-readiness-report/' + name + '.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  const summary = ['## Production readiness', '', 'Application: ' + (report.applicationSha ?? 'unavailable'),
    'Driver: ' + (report.driverRevision ?? 'unavailable'), 'Result: ' + report.status, '',
    '| Path | Metadata readiness | Code |', '| --- | --- | --- |',
    ...(report.cases ?? []).map(item => '| ' + item.case + ' | ' + item.status + ' | ' + (item.code ?? '') + ' |'), '',
    'The runner sent no task-creation, model-inference or preference-mutation request.',
    'Normal authenticated GETs may perform backend maintenance; database writes are not measured.',
    'Readiness does not prove paid execution, native claims, global project idleness or expired worker leases.', ''].join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const attesting = process.argv.includes('--attest')
  let report
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const plan = JSON.parse(await readFile('scripts/acceptance/production-readiness-plan.json', 'utf8'))
    report = attesting ? await attestReadiness({ event, plan }) : await runReadiness({ event, plan,
      attestation: JSON.parse(await readFile('production-readiness-report/attestation.json', 'utf8')) })
  } catch (error) { report = { purpose: 'production-readiness', taskState: 'not_requested', ...publicFailure(error) } }
  await output(attesting ? 'attestation' : 'report', report)
  if (attesting && report.metadataReadAuthorized === true && process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, 'readable=true\n')
  if (attesting ? report.metadataReadAuthorized !== true : report.status !== 'ready') process.exitCode = 1
}
