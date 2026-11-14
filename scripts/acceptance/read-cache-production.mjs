#!/usr/bin/env node
/** Production HTTP read-path acceptance. It does not run a browser or create fixtures. */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { changedListIds, heldListPositions, mergeList, readListPositions } from '../../lib/list-poll.ts'
import { mergeChat } from '../../lib/coordinator/chat-poll.ts'
import { persistentReadData } from '../../lib/swr/cache-policy.ts'
import { chatKeys, issueKeys, settingsKeys, threadKeys } from '../../lib/swr/keys.ts'
import { ORIGIN, REPOSITORY, successfulRelease } from './project-decisions.mjs'
import { attestReadiness, ReadinessError, triggerGuard } from './production-readiness.mjs'
import { createReadClient, discoverReadActions, requestAllowed as readRequestAllowed } from './read-cache.mjs'
import { DeployedTargetError, deployedTargetGuard, attestDeployedTarget, publicTargetFailure } from './deployed-target.mjs'
import { responseCookieJar } from './response-cookie-jar.mjs'

export { responseCookieJar }

const environment = Object.freeze({ origin: ORIGIN, basePath: '/mikka' })
const plan = Object.freeze({ purpose: 'production-readiness', mode: 'readonly' })
const repositoryApi = `https://api.github.com/repos/${REPOSITORY}`
const acceptanceIssue = (issueNumber, guard) => {
  check(issueNumber === 1372 || issueNumber === 1415 && guard.trigger === 'workflow_run', 'trigger_rejected')
  return { issueUrl: `${repositoryApi}/issues/${issueNumber}`, purpose: issueNumber === 1415 ? 'production-read-cache-migration' : 'production-read-cache' }
}
export const SCENARIOS = Object.freeze(['cold', 'warm', 'reload-restored', 'scoped-focus-catchup'])
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
const version = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const clone = value => JSON.parse(JSON.stringify(value))
const restoreRead = (key, data) => {
  const projected = persistentReadData(key, data)
  return projected === undefined ? undefined : clone(projected)
}
const blocked = new Set(['trigger_rejected', 'attestation_required', 'account_required', 'build_mismatch', 'sign_in_failed',
  'session_missing', 'session_identity', 'session_close_failed', 'existing_bot_missing', 'existing_task_missing',
  'existing_thread_missing', 'existing_chat_tail_missing',
  'scope_changed', 'read_access_changed', 'request_failed', 'http_refused', 'acceptance_timeout', 'action_discovery_failed',
  'deployment_proof', 'web_deploy', 'issue_proof'])
const failures = new Set(['request_denied', 'redirect_refused', 'response_invalid', 'list_merge_invalid', 'chat_merge_invalid', 'acceptance_failed'])
export class ProductionReadCacheError extends Error {
  constructor(code, options) {
    super(blocked.has(code) || failures.has(code) ? code : 'acceptance_failed', options)
    this.name = 'ProductionReadCacheError'; this.code = this.message
  }
}
const check = (condition, code) => { if (!condition) throw new ProductionReadCacheError(code) }
export function publicFailure(error) {
  if (error instanceof DeployedTargetError) return publicTargetFailure(error)
  if (error instanceof ProductionReadCacheError) return { status: blocked.has(error.code) ? 'blocked' : 'fail', code: error.code }
  // ReadinessError constructs its message from an existing closed code set.
  if (error instanceof ReadinessError) return { status: 'blocked', code: error.message }
  return { status: 'fail', code: 'acceptance_failed' }
}

function automaticRelease(run, applicationSha, runId) {
  return Boolean(run && run.id === runId && run.event === 'push' && run.repository?.full_name === REPOSITORY
    && run.url === `${repositoryApi}/actions/runs/${runId}`
    && successfulRelease([run], applicationSha, 'web') !== null)
}

/** The two real GitHub event types have independent guards. Never adapt a
 * workflow_run payload into a synthetic manual event for the readiness guard. */
export function productionGuard(env, event) {
  if (env.MIKKA_ACCEPTANCE_TARGET_MODE) return deployedTargetGuard(env, event)
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = event?.workflow_run
    check(env.GITHUB_REPOSITORY === REPOSITORY && event?.repository?.full_name === REPOSITORY
      && env.GITHUB_REF === 'refs/heads/main' && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
      && event.action === 'completed' && automaticRelease(run, env.GITHUB_SHA, run?.id), 'trigger_rejected')
    return { applicationSha: run.head_sha, driverRevision: env.GITHUB_SHA, mode: 'readonly', trigger: 'workflow_run', webDeployRunId: run.id }
  }
  check(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main', 'trigger_rejected')
  const guard = triggerGuard(env, event, plan)
  check(guard.applicationSha === guard.driverRevision, 'trigger_rejected')
  return guard
}

export async function attestProductionReadCache({ env = process.env, event, fetchImpl = fetch, now = Date.now, issueNumber = 1372 } = {}) {
  const guard = productionGuard(env, event)
  if (guard.targetMode === 'deployed-target') {
    check(issueNumber === 1415, 'trigger_rejected')
    return attestDeployedTarget({ env, event, fetchImpl, now })
  }
  const { issueUrl, purpose } = acceptanceIssue(issueNumber, guard)
  if (guard.trigger === 'workflow_run') {
    check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'deployment_proof')
    const read = async (url, github = false) => {
      let response
      try {
        response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { accept: 'application/json', 'cache-control': 'no-store', ...(github ? { authorization: `Bearer ${env.GH_TOKEN}` } : {}) } })
      } catch (error) { throw new ProductionReadCacheError('deployment_proof', { cause: error }) }
      check(response.ok && !response.redirected && (!response.url || new URL(response.url).origin === new URL(url).origin), 'deployment_proof')
      const value = await response.json().catch(() => null)
      check(value !== null, 'deployment_proof')
      return value
    }
    const issue = await read(issueUrl, true)
    check(issue?.number === issueNumber && issue.url === issueUrl && issue.repository_url === repositoryApi
      && !issue.pull_request && ['open', 'closed'].includes(issue.state), 'issue_proof')
    const base = { purpose, repository: REPOSITORY, ...guard,
      issueNumber, issueState: issue.state, executionReady: false }
    if (issue.state === 'closed') return { ...base, status: 'skipped', code: 'issue_closed',
      metadataReadAuthorized: false, readable: false, checkedAt: new Date(now()).toISOString() }
    const currentMain = async () => {
      if (issueNumber !== 1415) return
      const ref = await read(`${repositoryApi}/git/ref/heads/main`, true)
      check(ref.ref === 'refs/heads/main' && ref.object?.type === 'commit' && ref.object.sha === guard.applicationSha, 'build_mismatch')
    }
    await currentMain()
    const pin = async () => check((await read(`${ORIGIN}/mikka/api/version`)).build === guard.applicationSha, 'build_mismatch')
    await pin()
    const run = await read(`${repositoryApi}/actions/runs/${guard.webDeployRunId}`, true)
    check(automaticRelease(run, guard.applicationSha, guard.webDeployRunId), 'web_deploy')
    await pin()
    await currentMain()
    return { ...base, status: 'ready', metadataReadAuthorized: true, readable: true, checkedAt: new Date(now()).toISOString() }
  }
  // The existing proof checks the public build on both sides of a successful
  // exact-SHA Web deploy. Worker execution readiness is irrelevant to reads.
  return attestReadiness({ env, event, plan, fetchImpl, now })
}

function requireAttestation(guard, attestation, now, issueNumber) {
  check(attestation?.targetMode === undefined, 'attestation_required')
  const { purpose } = acceptanceIssue(issueNumber, guard)
  const age = now() - Date.parse(attestation?.checkedAt)
  check(attestation?.repository === REPOSITORY && attestation.mode === 'readonly'
    && attestation.applicationSha === guard.applicationSha && attestation.driverRevision === guard.driverRevision
    && attestation.executionReady === false
    && Number.isSafeInteger(attestation.webDeployRunId) && attestation.webDeployRunId > 0
    && Number.isFinite(age) && age >= 0 && age <= 300_000, 'attestation_required')
  if (guard.trigger === 'workflow_run') {
    check(attestation.purpose === purpose && attestation.trigger === 'workflow_run'
      && attestation.webDeployRunId === guard.webDeployRunId && attestation.issueNumber === issueNumber, 'attestation_required')
    if (attestation.status === 'skipped') {
      check(attestation.code === 'issue_closed' && attestation.issueState === 'closed'
        && attestation.metadataReadAuthorized === false && attestation.readable === false, 'attestation_required')
      return false
    }
    check(attestation.status === 'ready' && attestation.issueState === 'open' && attestation.readable === true, 'attestation_required')
  } else check(attestation.purpose === 'production-readiness' && ['ready', 'partial'].includes(attestation.status), 'attestation_required')
  check(attestation.metadataReadAuthorized === true, 'attestation_required')
  return true
}

/** Business requests cannot reach an authentication mutation, message, dispatch,
 * task writer, settings writer, SQL adapter or foreign origin. */
export function productionRequestAllowed(path, init = {}, refs = {}) {
  try {
    if (typeof path !== 'string' || path.includes('\\')) return false
    const url = new URL(path, ORIGIN), headers = new Headers(init.headers)
    if (url.origin !== ORIGIN || url.username || url.password || url.hash
      || ['authorization', 'cookie', 'host'].some(name => headers.has(name))) return false
    if (url.pathname === '/mikka/api/bots') return (init.method ?? 'GET') === 'GET'
      && !url.search && init.body === undefined && !headers.has('next-action')
    return readRequestAllowed(path, init, environment, refs)
  } catch { return false }
}

function access(result) {
  check(result && typeof result === 'object', 'response_invalid')
  check(!result.error, 'read_access_changed')
  return result
}

/** Reuse the product's merge and validate that every held proof has its row.
 * A live edit may return a delta or a reset at any step of the four reads. */
export function mergeReadList(previous, next, limit) {
  check(next && version(next.version), 'response_invalid')
  if (next.unchanged === true) {
    check(previous && previous.version === next.version && Array.isArray(previous.items), 'list_merge_invalid')
    return { ...previous, ...next, items: mergeList(previous.items, next), positions: previous.positions }
  }
  const positions = readListPositions(next.positions, limit)
  check(positions && Array.isArray(next.items) && next.items.every(item => uuid(item?.id)), 'response_invalid')
  const ids = new Set(positions.map(row => row.id)), delivered = new Set(next.items.map(item => item.id))
  check(delivered.size === next.items.length && next.items.every(item => ids.has(item.id)), 'list_merge_invalid')
  if (next.delta === true) check(previous && changedListIds(positions, previous.positions).every(id => delivered.has(id)), 'list_merge_invalid')
  const items = mergeList(previous?.items ?? [], next)
  check(items.length === positions.length && items.every((item, index) => item.id === positions[index].id), 'list_merge_invalid')
  return { ...next, items, positions }
}

export function mergeReadChat(previous, next) {
  check(next && version(next.version) && integer(next.cursor), 'response_invalid')
  if (next.unchanged === true) check(previous && previous.version === next.version, 'chat_merge_invalid')
  else {
    check(Array.isArray(next.items) && next.items.every(item => integer(item?.position)), 'response_invalid')
    if (next.after !== undefined) check(previous && integer(next.after) && next.after <= previous.cursor
      && next.baseCursor === previous.cursor, 'chat_merge_invalid')
  }
  const merged = mergeChat(previous, next), proof = merged?.continuation
  check(merged && Array.isArray(merged.items) && proof && integer(proof.after) && integer(proof.cursor)
    && proof.after <= proof.cursor && proof.cursor === merged.cursor && version(proof.prefix), 'chat_merge_invalid')
  check(new Set(merged.items.map(item => item.position)).size === merged.items.length, 'chat_merge_invalid')
  check(!merged.restoreToolMetadata && !('toolMetadata' in merged), 'chat_merge_invalid')
  return merged
}

const listArguments = previous => {
  if (!previous) return []
  const held = heldListPositions(previous)
  return [held && held.length === previous.positions?.length ? previous.version : undefined, held]
}
const chatProof = chat => chat?.continuation && { ...chat.continuation,
  ...(chat.restoreToolMetadata ? { restoreToolMetadata: true } : {}),
  sourceIds: Object.keys(chat.sources ?? {}).slice(0, 400), artifactIds: Object.keys(chat.artifacts ?? {}).slice(0, 400) }
const mode = value => value?.unchanged === true ? 'unchanged' : value?.delta === true || value?.after !== undefined ? 'delta' : 'snapshot'

export async function runProductionReadCache({ env = process.env, event, attestation, fetchImpl = fetch, now = Date.now, issueNumber = 1372 } = {}) {
  const guard = productionGuard(env, event)
  // This explicit migration mode authorizes attestation, not the historical read measurements.
  check(guard.targetMode !== 'deployed-target', 'trigger_rejected')
  const { purpose } = acceptanceIssue(issueNumber, guard)
  if (!requireAttestation(guard, attestation, now, issueNumber)) return { purpose, ...guard,
    status: 'skipped', code: 'issue_closed', metadataReadAuthorized: false, readable: false }
  // Credentials are not even read until the immutable deployment proof passed.
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  check(isSmokeAccountEmail(email) && typeof password === 'string' && password.length > 0, 'account_required')
  const measurements = [], refs = {}, deadline = now() + 300_000
  const report = { version: 1, issue: issueNumber, purpose, ...guard, webDeployRunId: attestation.webDeployRunId,
    status: 'running', startedAt: now(), normalSessionObserved: false, sessionClosed: false,
    browserCacheVerified: false, businessMutationRequests: 0, modelCalls: 0, fixturesCreated: 0, backendMaintenanceWritesMeasured: false,
    cacheMissProbe: 'discard-one-held-item-with-server-issued-proofs', reads: [] }
  const cookies = responseCookieJar(now), sessionURL = new URL('/mikka/api/auth/get-session', ORIGIN)
  let ownerId, workspaceId, closeSession = false
  const fetchBound = async (path, init, logout = false) => {
    check(logout || now() < deadline, 'acceptance_timeout')
    const url = new URL(path, ORIGIN), headers = new Headers(init?.headers), cookie = cookies.header(url)
    headers.set('origin', ORIGIN); headers.set('cache-control', 'no-store')
    if (cookie) headers.set('cookie', cookie)
    let response
    try {
      response = await fetchImpl(url, { ...init, headers, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(logout ? 30_000 : Math.max(1, Math.min(30_000, deadline - now()))) })
    } catch (error) { throw new ProductionReadCacheError('request_failed', { cause: error }) }
    check(!response.redirected && (response.status < 300 || response.status >= 400)
      && (!response.url || new URL(response.url).origin === ORIGIN), 'redirect_refused')
    cookies.receive(url, response.headers)
    return response
  }
  const request = (path, init = {}) => {
    check(productionRequestAllowed(path, init, refs), 'request_denied')
    return fetchBound(path, init)
  }
  // This private auth path is used only for one normal sign-in and its own
  // current-cookie sign-out; business callers have no auth mutation capability.
  const auth = (action, body) => {
    check(action === 'sign-in/email' || action === 'sign-out', 'request_denied')
    return fetchBound(`/mikka/api/auth/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, action === 'sign-out')
  }
  const json = async path => {
    const response = await request(path), value = await response.json().catch(() => null)
    check(response.ok && value !== null && !value?.error, 'http_refused')
    return value
  }
  const client = createReadClient({ request }, environment, 'owner', measurements, refs)
  const pin = async () => check((await json('/mikka/api/version')).build === guard.applicationSha, 'build_mismatch')
  const session = async () => {
    const value = await json('/mikka/api/auth/get-session')
    check(value?.user?.email?.toLowerCase() === email.toLowerCase()
      && typeof value.user.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.user.id)
      && (!ownerId || value.user.id === ownerId), 'session_identity')
    return value.user.id
  }
  const listScope = (next, selected = false) => check(next.live?.ownerId === ownerId
    && (!selected || next.live?.selectedWorkspaceId === workspaceId), 'scope_changed')
  const measureResult = value => {
    const record = measurements.at(-1)
    record.responseMode = mode(value)
    if (Array.isArray(value?.items)) record.receivedItems = value.items.length
    if (Array.isArray(value?.toolMetadata?.rows)) record.toolMetadataRows = value.toolMetadata.rows.length
  }
  const action = async (name, args, surface, scenario) => access(await client.action(name, args, surface, scenario))
  try {
    await pin()
    const login = await auth('sign-in/email', { email, password })
    closeSession = cookies.header(sessionURL).length > 0
    check(login.ok, 'sign_in_failed'); check(closeSession, 'session_missing')
    ownerId = await session(); report.normalSessionObserved = true
    const bots = await json('/mikka/api/bots')
    check(Array.isArray(bots), 'response_invalid'); check(bots.length > 0, 'existing_bot_missing')
    workspaceId = bots[0].workspaceId
    check(uuid(workspaceId) && bots.every(bot => uuid(bot.id) && bot.ownerId === ownerId && bot.workspaceId === workspaceId), 'scope_changed')
    const botId = bots[0].id
    report.existingOwnedBots = bots.length
    let discovered
    try { discovered = await discoverReadActions(request, environment) }
    catch (error) { throw new ProductionReadCacheError('action_discovery_failed', { cause: error }) }
    Object.assign(refs, discovered.refs)
    report.discovery = { pagesRead: discovered.diagnostics.pagesRead, chunksRead: discovered.diagnostics.chunksRead, readActions: discovered.diagnostics.found.length }
    const first = (await action('syncIssueList', [], 'task-list', 'cold')).snapshot
    listScope(first, true); measureResult(first)
    let held = { issues: mergeReadList(undefined, first, 100) }
    check(held.issues.items.length > 0, 'existing_task_missing')
    const issueId = held.issues.items[0].id
    report.existingVisibleTasks = held.issues.items.length
    for (const scenario of SCENARIOS) {
      // Restore the same allowed read models as the browser. A rejected record
      // has no proof; redacted tool labels request a prefix metadata repair.
      // This still does not exercise IndexedDB, first paint, or a focus event.
      if (scenario === 'reload-restored') held = {
        issues: restoreRead(issueKeys.list(ownerId, workspaceId), held.issues),
        threads: restoreRead(threadKeys.list(ownerId), held.threads),
        chat: restoreRead(chatKeys.detail(botId), held.chat),
        detail: restoreRead(issueKeys.detail(issueId), held.detail),
        activity: restoreRead(issueKeys.activityVersions(issueId), held.activity),
        prefix: restoreRead(settingsKeys.issuePrefix(), held.prefix),
      }
      if (scenario !== 'cold') {
        const next = (await action('syncIssueList', listArguments(held.issues), 'task-list', scenario)).snapshot
        listScope(next, true); measureResult(next); held.issues = mergeReadList(held.issues, next, 100)
      }
      const threads = (await action('syncThreadList', listArguments(held.threads), 'thread-list', scenario)).snapshot
      listScope(threads); measureResult(threads); held.threads = mergeReadList(held.threads, threads, 200)
      const refreshMetadata = scenario === 'reload-restored' || scenario === 'scoped-focus-catchup'
      const chat = (await action('syncCoordinatorChat', [botId, refreshMetadata ? undefined : held.chat?.version, chatProof(held.chat)], 'bot-chat', scenario)).chat
      check(chat?.botId === botId, 'scope_changed'); listScope(chat); measureResult(chat)
      try { held.chat = mergeReadChat(held.chat, chat) }
      catch (error) {
        // Match the browser's single bounded reset when a restored prefix's
        // tool identities cannot be repaired completely. Both responses count.
        if (!(error instanceof ProductionReadCacheError && error.code === 'chat_merge_invalid' && held.chat?.restoreToolMetadata && chat.after !== undefined)) throw error
        const full = (await action('syncCoordinatorChat', [botId], 'bot-chat', scenario)).chat
        check(full?.botId === botId, 'scope_changed'); listScope(full); measureResult(full)
        held.chat = mergeReadChat(undefined, full)
      }
      const detail = await action('pollIssue', [issueId, held.detail?.readVersion], 'task-detail', scenario)
      check(detail.viewerId === ownerId, 'scope_changed'); check(version(detail.version), 'response_invalid'); measureResult(detail)
      if (detail.unchanged === true) check(held.detail?.readVersion === detail.version, 'list_merge_invalid')
      else { check(detail.issue?.id === issueId && detail.issue.content && typeof detail.issue.content === 'object', 'response_invalid'); held.detail = { ...detail.issue, readVersion: detail.version } }
      const activity = await action('pollIssueVersionSummaries', [issueId, ...listArguments(held.activity)], 'task-activity', scenario)
      check(activity.viewerId === ownerId, 'scope_changed'); measureResult(activity.snapshot)
      held.activity = mergeReadList(held.activity, activity.snapshot, 50)
      const prefix = await client.json('/mikka/api/settings/issue-prefix', 'settings', scenario)
      check(typeof prefix?.suggested === 'string' && Array.isArray(prefix.teamKeys)
        && prefix.teamKeys.every(key => typeof key === 'string'), 'response_invalid')
      held.prefix = prefix
    }
    // Exercise a one-item incremental repair without changing production data.
    // Discard one actually held row and its proof; every retained proof still
    // came from the server. A concurrent edit/deletion may return more rows or
    // a full chat reset, so record the actual mode/count instead of calling it
    // an observed production mutation or requiring an idle workspace.
    for (const [name, surface, key, limit, missing] of [
      ['syncIssueList', 'task-list', 'issues', 100, 'existing_task_missing'],
      ['syncThreadList', 'thread-list', 'threads', 200, 'existing_thread_missing'],
    ]) {
      const current = held[key]
      check(current?.items.length > 0, missing)
      const removedId = current.items.at(-1).id
      const partial = { ...current, version: undefined,
        items: current.items.filter(item => item.id !== removedId),
        positions: current.positions.filter(row => row.id !== removedId) }
      const next = (await action(name, listArguments(partial), surface, 'one-item-cache-miss')).snapshot
      listScope(next, key === 'issues'); measureResult(next)
      held[key] = mergeReadList(partial, next, limit)
    }
    const proof = held.chat?.continuation
    check(proof && held.chat.items.some(item => !item.pending && item.position > proof.after), 'existing_chat_tail_missing')
    const partialChat = { ...held.chat, version: undefined, cursor: proof.after,
      items: held.chat.items.filter(item => !item.pending && item.position <= proof.after),
      continuation: { ...proof, cursor: proof.after } }
    const repairedChat = (await action('syncCoordinatorChat', [botId, undefined, chatProof(partialChat)], 'bot-chat', 'one-item-cache-miss')).chat
    check(repairedChat?.botId === botId, 'scope_changed'); listScope(repairedChat); measureResult(repairedChat)
    held.chat = mergeReadChat(partialChat, repairedChat)
    await session(); await pin()
    report.status = 'pass'
  } catch (error) { Object.assign(report, publicFailure(error)) }
  finally {
    const needsLogout = closeSession
    if (needsLogout) report.sessionClosed = await auth('sign-out', {}).then(response => response.ok).catch(() => false)
    if (needsLogout && !report.sessionClosed) { report.status = 'blocked'; report.code = 'session_close_failed' }
    cookies.clear()
    // No rows, identifiers, cursor hashes, cookie material or upstream errors
    // enter evidence. Application/driver SHAs identify the tested deployment.
    report.reads = measurements.map(({ operation, scenario, httpStatus, httpBytes, jsonBytes, traceId, responseMode, receivedItems, toolMetadataRows }) => ({
      action: operation, scenario, httpStatus, httpBytes, resultBytes: jsonBytes, traceId,
      ...(responseMode ? { responseMode } : {}), ...(receivedItems === undefined ? {} : { receivedItems }),
      ...(toolMetadataRows === undefined ? {} : { toolMetadataRows }),
    }))
    report.finishedAt = now()
  }
  return report
}

async function output(name, report) {
  await mkdir('production-read-cache-report', { recursive: true, mode: 0o700 })
  await writeFile(`production-read-cache-report/${name}.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report))
}

export function productionOutcome(report, attesting = false) {
  const readable = report.metadataReadAuthorized === true
  const skipped = report.status === 'skipped' && report.code === 'issue_closed' && report.metadataReadAuthorized === false
  return { readable, exitCode: skipped || (attesting ? readable : report.status === 'pass') ? 0 : 1 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const attesting = process.argv.includes('--attest')
  const issueNumber = process.argv.includes('--migration-1415') ? 1415 : 1372
  let report
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    report = attesting ? await attestProductionReadCache({ event, issueNumber }) : await runProductionReadCache({ event, issueNumber,
      attestation: JSON.parse(await readFile('production-read-cache-report/attestation.json', 'utf8')) })
  } catch (error) { report = publicFailure(error) }
  await output(attesting ? 'attestation' : 'report', report)
  const outcome = productionOutcome(report, attesting)
  if (attesting && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `readable=${outcome.readable}\n`)
  process.exitCode = outcome.exitCode
}
