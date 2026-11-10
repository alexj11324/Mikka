#!/usr/bin/env node
/** #1820: current-main owner APIs; no database access or synthetic webhook.
 * Without an exact, independently readable GitHub fixture this runs inventory
 * only and reports incomplete acceptance. Historical inbox entries are read,
 * never selected for mutation by their title, age, position or prefix.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam, restoreAcceptanceWorkspace } from './cloud-startup.mjs'
import { assertCoreProductionTarget, attestCoreProduction, CORE_ORIGIN } from './self-hosted-production-target.mjs'
import { inboxSelectionFailure } from './inbox-production-target.mjs'
import { selectInboxAcceptance } from './self-hosted-production-followup-target.mjs'
import { inboxBindingJournal, inboxJournalEnvelope, INBOX_JOURNAL_PREFIX, inboxRecoveryFailure, readInboxRecovery } from './inbox-production-recovery.mjs'
import { liveInvalidation, liveReadiness } from '../../lib/live/events.ts'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/
const REPOSITORY = 'alexj11324/Mikka-handoff'
const GITHUB_API = 'https://api.github.com'
const GATEWAYS = new Set(['wss://mikka-gateway.aspectlylabs.com', 'wss://mikka-device-gateway.orvilo-preview.workers.dev'])
const LIVE_KEYS = ['issue_list', 'pending_actions']
const CODES = new Set(['target_refused', 'build_changed', 'identity_failed', 'response_invalid', 'unexpected_status',
  'fixture_binding_failed', 'fixture_unavailable', 'fixture_expired', 'inventory_incomplete', 'command_mismatch',
  'receipt_mismatch', 'live_invalid', 'live_disconnected', 'live_timeout', 'cleanup_failed', 'request_failed', 'receipt_failed', 'recovery_scope_invalid'])
const BODY_CODES = new Set(['authRequired', 'originNotAllowed', 'workspaceAccessDenied', 'inboxNotFound', 'inboxConflict',
  'inboxInvalid', 'factoryNotFound', 'factoryHumanRequired', 'factoryUnavailable', 'githubUnavailable',
  'githubNotConnected', 'githubNotConfigured', 'githubAccessDenied', 'cloud_access_denied'])
const positive = value => Number.isSafeInteger(value) && value > 0
const count = value => Number.isSafeInteger(value) && value >= 0
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const digest = value => createHash('sha256').update(value).digest('hex')
const post = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
class ProbeError extends Error {
  constructor(code, status = null, body = null) { super(CODES.has(code) ? code : 'request_failed'); this.status = status; this.body = body }
}
const check = (value, code = 'response_invalid') => { if (!value) throw new ProbeError(code) }
const closedBody = value => ({ errorCode: BODY_CODES.has(value?.error) ? value.error : 'other' })
function selectionError(error) {
  const seen = new Set()
  for (let item = error, depth = 0; item && typeof item === 'object' && !seen.has(item) && depth < 5; item = item.cause, depth++) {
    if (inboxSelectionFailure(item)) return item
    seen.add(item)
  }
  return null
}
const failure = error => inboxSelectionFailure(selectionError(error)) ?? inboxRecoveryFailure(error) ?? ({ code: CODES.has(error?.message) ? error.message : 'request_failed',
  ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}),
  ...(error instanceof ProbeError && error.body ? { body: error.body } : {}) })
async function responseJson(response) {
  const reader = response.body?.getReader(), chunks = []; let length = 0
  check(reader)
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break
      length += next.value.byteLength
      if (length > 2_000_000) { await reader.cancel(); throw new ProbeError('response_invalid', response.status) }
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) { if (error instanceof ProbeError) throw error; throw new ProbeError('response_invalid', response.status) }
  finally { reader.releaseLock() }
}

/** The existing owner channel, with exact gateway/path and expiring ticket.
 * Event waits cause one read after a real push, never a polling fallback.
 */
export function inboxLiveSocket(value, { ownerId, workspaceId, now = Date.now,
  socketFactory = (url, protocol) => new WebSocket(url, protocol), timeoutMs = 10_000, heartbeatMs = 30_000 } = {}) {
  let url
  try { url = new URL(value?.url) } catch { throw new ProbeError('live_invalid') }
  const channel = digest(JSON.stringify([ownerId, workspaceId]))
  const protocol = /^mikka-ticket-([0-9]+)-[a-f0-9]{64}$/.exec(value?.protocol ?? '')
  check(typeof ownerId === 'string' && UUID.test(workspaceId ?? '') && GATEWAYS.has(url.origin)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/v1/live/' + channel + '/socket'
    && protocol && value.expiresAt === Number(protocol[1]) * 1000 && value.expiresAt > now()
    && value.expiresAt <= now() + 305_000, 'live_invalid')
  const socket = socketFactory(url.href, value.protocol), waiters = new Set(), events = []
  let opened = false, ready = false, closed = false, failed, heartbeat, pong = true
  const update = () => { for (const waiter of waiters) waiter() }
  const listeners = [
    ['open', () => {
      opened = true
      heartbeat = setInterval(() => {
        if (closed || failed) return
        if (!pong) { failed = new ProbeError('live_disconnected'); update(); return }
        pong = false
        try { socket.send('ping') } catch { failed = new ProbeError('live_disconnected'); update() }
      }, heartbeatMs)
      heartbeat.unref?.(); update()
    }],
    ['message', event => {
      if (closed || typeof event.data !== 'string' || event.data.length > 2048) return
      if (event.data === 'pong') { pong = true; return }
      let frame; try { frame = JSON.parse(event.data) } catch { return }
      const readiness = liveReadiness(frame)
      if (readiness) {
        if (LIVE_KEYS.every(key => readiness.kinds.includes(key))) ready = true
        else failed = new ProbeError('live_invalid')
      }
      const key = liveInvalidation(frame, true)
      if (key?.id === workspaceId && LIVE_KEYS.includes(key.kind)) events.push({ kind: key.kind, at: now() })
      update()
    }],
    ['close', () => { clearInterval(heartbeat); if (!closed) failed = new ProbeError('live_disconnected'); update() }],
    ['error', () => { clearInterval(heartbeat); if (!closed) failed = new ProbeError('live_disconnected'); update() }],
  ]
  for (const [name, listener] of listeners) socket.addEventListener(name, listener)
  const wait = (predicate, milliseconds) => new Promise((resolve, reject) => {
    let timer
    const finish = error => { clearTimeout(timer); waiters.delete(observe); if (error) reject(error); else resolve() }
    const observe = () => { if (failed) finish(failed); else if (closed) finish(new ProbeError('live_disconnected')); else if (predicate()) finish() }
    timer = setTimeout(() => finish(new ProbeError('live_timeout')), milliseconds)
    waiters.add(observe); observe()
  })
  return {
    ready: () => wait(() => opened && ready, timeoutMs),
    expect({ after = now(), timeout = timeoutMs } = {}) {
      const start = events.length
      const receipt = wait(() => LIVE_KEYS.every(kind => events.slice(start).some(event => event.kind === kind && event.at >= after)), timeout)
        .then(() => null, error => error)
      // Attach rejection handling immediately, including when the HTTP write fails.
      return async () => { const error = await receipt; if (error) throw error; return { keys: [...LIVE_KEYS], observedAt: new Date(now()).toISOString() } }
    },
    async close() {
      closed = true; clearInterval(heartbeat); update()
      try {
        if (socket.readyState === 3) return
        await new Promise((resolve, reject) => {
          let timer
          const done = () => { clearTimeout(timer); socket.removeEventListener('close', done); resolve() }
          timer = setTimeout(() => { socket.removeEventListener('close', done); reject(new ProbeError('cleanup_failed')) }, 3_000)
          socket.addEventListener('close', done)
          try { socket.close() } catch { clearTimeout(timer); socket.removeEventListener('close', done); reject(new ProbeError('cleanup_failed')) }
        })
      } finally { for (const [name, listener] of listeners) socket.removeEventListener(name, listener) }
    },
  }
}

function validatePage(body, workspaceId, tab) {
  check(object(body) && Array.isArray(body.items) && body.items.length <= 100 && iso(body.historySince)
    && body.historyBackfilled === false && (body.nextCursor === null || typeof body.nextCursor === 'string' && body.nextCursor.length <= 1024)
    && body.live?.workspaceId === workspaceId && LIVE_KEYS.every(key => body.live.keys?.includes(key)))
  for (const item of body.items) {
    check(UUID.test(item?.id ?? '') && ['suggestion', 'task'].includes(item.type) && typeof item.source === 'string'
      && typeof item.ownerId === 'string' && typeof item.pending === 'boolean' && typeof item.canReply === 'boolean'
      && item.status === tab && (item.snoozedUntil === null || iso(item.snoozedUntil))
      && (item.rejectedAt === null || iso(item.rejectedAt)) && (item.rejectedBy === null || typeof item.rejectedBy === 'string')
      && Array.isArray(item.actions) && item.actions.every(action => ['open', 'reply', 'accept', 'reject', 'undo_reject', 'snooze', 'reopen'].includes(action)))
    if (tab === 'done') check(UUID.test(item.completion?.id ?? '') && typeof item.completion.actorId === 'string'
      && iso(item.completion.at) && ['answered', 'approved', 'merged', 'accepted', 'rejected'].includes(item.completion.action))
  }
  return body
}

/** Public, disposable issue and exact event, plus an identity already linked
 * to this owner. A trusted manifest alone never authorizes an arbitrary card.
 */
export async function verifyInboxFixture(fixture, { ownerId, personalWorkspaceId, recipientIds, githubRead,
  applicationSha, driverRunId, driverRunAttempt, now = Date.now }) {
  check(fixture?.schema === 1 && fixture.purpose === 'mikka1820-owner-github-fixture' && UUID.test(fixture.nonce ?? '')
    && fixture.ownerHash === digest(ownerId) && fixture.workspaceId === personalWorkspaceId
    && fixture.applicationSha === applicationSha && fixture.inventoryRunId === driverRunId
    && positive(fixture.inventoryRunAttempt) && fixture.inventoryRunAttempt <= driverRunAttempt
    && iso(fixture.createdAt) && iso(fixture.expiresAt) && fixture.github?.repository === REPOSITORY
    && ['assigned', 'issue_comment'].includes(fixture.github.kind) && positive(fixture.github.issueNumber)
    && positive(fixture.github.eventId) && /^[1-9]\d*$/.test(fixture.github.recipientId ?? '')
    && /^[1-9]\d*$/.test(fixture.github.actorId ?? ''), 'fixture_binding_failed')
  check(Date.parse(fixture.createdAt) <= now() && Date.parse(fixture.expiresAt) > now()
    && Date.parse(fixture.expiresAt) - Date.parse(fixture.createdAt) <= 6 * 60 * 60_000, 'fixture_expired')
  check(recipientIds.has(fixture.github.recipientId), 'fixture_binding_failed')
  const { issueNumber, eventId, kind, recipientId, actorId } = fixture.github
  const issue = await githubRead(`/repos/${REPOSITORY}/issues/${issueNumber}`)
  const marker = `<!-- mikka-inbox-1820:${fixture.nonce} -->`
  check(issue?.number === issueNumber && issue.url === `${GITHUB_API}/repos/${REPOSITORY}/issues/${issueNumber}`
    && [`https://github.com/${REPOSITORY}/issues/${issueNumber}`, `https://github.com/${REPOSITORY}/pull/${issueNumber}`].includes(issue.html_url)
    && typeof issue.body === 'string' && issue.body.includes(marker) && iso(issue.created_at)
    && Date.parse(issue.created_at) >= Math.floor(Date.parse(fixture.createdAt) / 1000) * 1000 && Date.parse(issue.created_at) <= now()
    && issue.state === 'closed' && iso(issue.closed_at), 'fixture_binding_failed')
  const event = await githubRead(`/repos/${REPOSITORY}/issues/${kind === 'assigned' ? 'events' : 'comments'}/${eventId}`)
  check(event?.id === eventId && iso(event.created_at) && Date.parse(event.created_at) >= Date.parse(issue.created_at)
    && Date.parse(event.created_at) <= Date.parse(issue.closed_at) && Date.parse(issue.closed_at) <= now(), 'fixture_binding_failed')
  let sourceUrl
  if (kind === 'assigned') {
    check(event.event === 'assigned' && String(event.assignee?.id) === recipientId && String(event.actor?.id) === actorId
      && String(issue.user?.id) === actorId && issue.assignees?.some(user => String(user.id) === recipientId)
      && event.issue?.number === issueNumber && event.issue?.url === issue.url, 'fixture_binding_failed')
    sourceUrl = issue.html_url
  } else {
    check(event.issue_url === issue.url && event.html_url === issue.html_url + '#issuecomment-' + eventId
      && String(event.user?.id) === actorId && String(issue.user?.id) === recipientId
      && typeof event.body === 'string' && event.body.includes(marker), 'fixture_binding_failed')
    sourceUrl = event.html_url
  }
  return { nonce: fixture.nonce, sourceUrl, occurredAt: new Date(event.created_at).toISOString(), action: kind === 'assigned' ? 'handle' : 'reply',
    required: kind === 'assigned', externalSourceClosed: true, sourceEventId: eventId, sourceIssueNumber: issueNumber }
}

function reviewSummary(flow) {
  check(flow?.version === 2 && UUID.test(flow.id ?? '') && UUID.test(flow.issueId ?? '') && count(flow.revision))
  if (flow.pullRequest === null) {
    check(flow.review === null || flow.review.summary === null)
    return { kind: 'no_pr', taskId: flow.id, revision: flow.revision }
  }
  check(object(flow.pullRequest) && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(flow.pullRequest.url))
  const summary = flow.review?.summary
  check(object(summary) && (summary.branch === null || typeof summary.branch === 'string')
    && ['additions', 'deletions', 'changedFiles'].every(key => summary[key] === null || count(summary[key]))
    && (summary.headSha === null || /^[a-f0-9]{40,64}$/.test(summary.headSha ?? ''))
    && (summary.checksUpdatedAt === null || iso(summary.checksUpdatedAt))
    && (summary.checks === null || ['passed', 'failed', 'pending', 'skipped'].every(key => count(summary.checks[key]))))
  const complete = Boolean(summary.branch && summary.headSha && ['additions', 'deletions', 'changedFiles'].every(key => count(summary[key]))
    && summary.checks && iso(summary.checksUpdatedAt))
  return { kind: 'pr', taskId: flow.id, revision: flow.revision, handoff: flow.stage === 'handoff' && flow.needsYou?.kind === 'pr_review',
    complete, summaryDigest: digest(JSON.stringify(summary)), headSha: summary.headSha,
    additions: summary.additions, deletions: summary.deletions, changedFiles: summary.changedFiles,
    branchPresent: Boolean(summary.branch), checks: summary.checks, checksUpdatedAt: summary.checksUpdatedAt }
}

/** Discover real samples through the existing owner APIs. The task endpoint
 * limits raw rows before source/scope filtering and has no cursor: neither an
 * empty nor a short response proves that an issue has no other tasks or PRs.
 * Only issue pagination and the reads of actually returned tasks can exhaust.
 */
export async function readInboxFactoryInventory({ workspaceId, request, observe = () => {}, beforePage = async () => {}, now = Date.now,
  deadline = now() + 180_000, requestLimit = 400, issuePageLimit = 10 } = {}) {
  check(UUID.test(workspaceId ?? ''))
  check(positive(requestLimit) && requestLimit <= 400 && positive(issuePageLimit) && issuePageLimit <= 10
    && Number.isFinite(deadline))
  const inventory = { selectedWorkspaceId: workspaceId, issuesRead: 0, tasksRead: 0, denied: 0, complete: false,
    taskCompleteness: 'unknown_server_limit_before_filter', issuePaginationComplete: false,
    returnedTaskReadsComplete: false, requests: 0, stopReason: null,
    bounds: { requests: requestLimit, issuePagesPerWorkspace: issuePageLimit },
    workspaces: [{ workspaceId, visited: false, issuePages: 0,
      issuesRead: 0, tasksReturned: 0, tasksRead: 0, denied: 0, issuePaginationComplete: false,
      returnedTaskReadsComplete: false, stopReason: 'not_visited' }], summaries: [] }
  observe(inventory)
  const bounded = () => {
    if (now() >= deadline) inventory.stopReason = 'time_limit'
    else if (inventory.requests >= requestLimit) inventory.stopReason = 'request_limit'
    return inventory.stopReason === null
  }
  const read = async (step, path, workspaceId, expected = [200]) => {
    inventory.requests++
    return request(step, path, { headers: { 'x-mikka-workspace-id': workspaceId } }, expected)
  }
  discovery: for (const [workspaceIndex, scope] of inventory.workspaces.entries()) {
    const workspaceId = scope.workspaceId, issueIds = new Set(), cursors = new Set()
    let cursor
    for (let pageIndex = 0; pageIndex < issuePageLimit; pageIndex++) {
      if (!bounded()) { scope.stopReason = inventory.stopReason; break discovery }
      await beforePage()
      if (!bounded()) { scope.stopReason = inventory.stopReason; break discovery }
      scope.visited = true; scope.stopReason = null
      const { body: issues } = await read(`factory_issues_${workspaceIndex}_${pageIndex}`, '/api/issues/search?' + new URLSearchParams({
        workspaceId, limit: '50', ...(cursor ? { cursor } : {}),
      }), workspaceId)
      check(Array.isArray(issues?.items) && issues.items.length <= 50 && typeof issues.truncated === 'boolean'
        && (issues.nextCursor === null || typeof issues.nextCursor === 'string' && issues.nextCursor.length > 0 && issues.nextCursor.length <= 2048))
      scope.issuePages++
      for (const [issueIndex, issue] of issues.items.entries()) {
        check(UUID.test(issue?.id ?? '') && !issueIds.has(issue.id)); issueIds.add(issue.id)
        if (!bounded()) { scope.stopReason = inventory.stopReason; break discovery }
        const tag = `${workspaceIndex}_${pageIndex}_${issueIndex}`
        const list = await read('factory_tasks_' + tag, '/api/factory/tasks?issueId=' + issue.id, workspaceId, [200, 404])
        inventory.issuesRead++; scope.issuesRead++
        if (list.status === 404) { inventory.denied++; scope.denied++; continue }
        check(list.body?.issueId === issue.id && list.body.liveWorkspaceId === workspaceId
          && Array.isArray(list.body.tasks) && list.body.tasks.length <= 50)
        const taskIds = new Set()
        scope.tasksReturned += list.body.tasks.length
        for (const [taskIndex, task] of list.body.tasks.entries()) {
          check(UUID.test(task?.id ?? '') && !taskIds.has(task.id)); taskIds.add(task.id)
          if (!bounded()) { scope.stopReason = inventory.stopReason; break discovery }
          const path = `/api/factory/tasks/${task.id}/flow`
          const { body: flow } = await read(`factory_flow_${tag}_${taskIndex}`, path, workspaceId)
          check(flow?.id === task.id && flow.issueId === issue.id, 'fixture_binding_failed')
          const observed = { workspaceId, issueId: issue.id, ...reviewSummary(flow) }
          inventory.tasksRead++; scope.tasksRead++; inventory.summaries.push(observed)
          if (observed.kind === 'pr' && observed.complete && observed.handoff) {
            if (!bounded()) { scope.stopReason = inventory.stopReason; break discovery }
            const { body: second } = await read(`factory_readback_${tag}_${taskIndex}`, path, workspaceId)
            check(second?.id === task.id && second.issueId === issue.id, 'fixture_binding_failed')
            const readback = reviewSummary(second)
            observed.sameReadback = readback.kind === 'pr' && readback.complete && readback.handoff
              && readback.revision === observed.revision && readback.summaryDigest === observed.summaryDigest
          }
        }
      }
      if (issues.truncated) { scope.stopReason = 'issue_search_truncated'; break }
      if (issues.nextCursor === null) { scope.issuePaginationComplete = true; break }
      check(!cursors.has(issues.nextCursor)); cursors.add(issues.nextCursor); cursor = issues.nextCursor
      if (pageIndex === issuePageLimit - 1) scope.stopReason = 'issue_page_limit'
    }
    scope.returnedTaskReadsComplete = scope.tasksRead === scope.tasksReturned && scope.denied === 0
  }
  inventory.issuePaginationComplete = inventory.workspaces.every(row => row.issuePaginationComplete)
  inventory.returnedTaskReadsComplete = inventory.stopReason === null
    && inventory.workspaces.every(row => row.visited && row.returnedTaskReadsComplete)
  return inventory
}

export async function runInboxProduction({ env = process.env, event, attestation, selection, fetchImpl = fetch,
  selectTarget = selectInboxAcceptance,
  assertTarget = assertCoreProductionTarget, selectTeam = selectAcceptanceTeam, restoreWorkspace = restoreAcceptanceWorkspace,
  now = Date.now, socketFactory, readRecovery = readInboxRecovery, writeReceipt = async () => { throw new ProbeError('receipt_failed') } } = {}) {
  const report = { schema: 1, kind: 'mikka1820-production-api', status: 'failed', completeAcceptance: false,
    startedAt: new Date(now()).toISOString(), checks: {}, responses: [], inventory: {}, cleanup: { failures: [] },
    coverage: { inboxRead: 'not_exercised', rejectUndo: 'not_exercised', snoozeReopen: 'not_exercised',
      snoozeExpiryPush: 'not_exercised', doneReceipt: 'not_exercised', cachedReviewSummary: 'not_observed', noPrNull: 'not_observed' },
    limitations: ['Production HTTP reads observe persisted summaries; the version-bound source/PG tests establish absence of per-request GitHub calls.',
      'An existing task or suggestion is never mutated during inventory.',
      'The owner API retains completion history; cleanup dismisses only the exact disposable suggestion and leaves its receipt.'] }
  let client, account, ownerId, source, originalWorkspaceId, originalCookie = '', personalWorkspaceId, signInAttempted = false
  let suggestionId, boundFixture, live, phase = 'target', deadline, closing = false, bindingJournaled = false
  let selected, fixture, recovery, selectedWorkspaceId, sessionIdHash, identitySessionId
  let priorSessionIdHashes = []
  const recoverySessions = [], recoveryTokens = new Set()
  const cleanupWriteAllowed = (path, init) => {
    if (init.method !== 'POST' || typeof init.body !== 'string' || init.body.length > 4096) return false
    let body; try { body = JSON.parse(init.body) } catch { return false }
    if (!object(body)) return false
    const keys = Object.keys(body).sort().join(',')
    if (path === '/mikka/api/auth/sign-out') return keys === ''
    if (!ownerId) return false
    if (path === '/mikka/api/auth/revoke-session') return bindingJournaled && Boolean(recovery)
      && keys === 'token' && recoveryTokens.has(body.token)
    if (path === '/mikka/api/rpc') return keys === 'action,args,version' && body.version === 1
      && body.action === 'workspace.switchWorkspace' && UUID.test(originalWorkspaceId ?? '')
      && (!recovery || bindingJournaled)
      && Array.isArray(body.args) && body.args.length === 1 && body.args[0] === originalWorkspaceId
    return path === '/mikka/api/inbox' && bindingJournaled && Boolean(boundFixture)
      && keys === 'action,id,type,workspaceId' && body.workspaceId === personalWorkspaceId
      && body.type === 'suggestion' && body.id === suggestionId && ['reopen', 'reject'].includes(body.action)
  }
  const lease = async () => {
    const fresh = await selectTarget({ env, event, attestation: selected?.attestation ?? attestation, fetchImpl, now,
      expectedSelection: selected, assertTarget })
    check(fresh?.selected === true && fresh.applicationSha === source, 'target_refused')
    check(closing || Date.parse(fresh.window.expiresAt) - now() >= 60_000, 'target_refused')
    selected = fresh
  }
  const boundedFetch = (url, init = {}) => {
    const remaining = closing ? 15_000 : Math.min(15_000, deadline - Date.now())
    check(Number.isFinite(remaining) && remaining > 0, 'request_failed')
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(remaining)))
    return fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal })
  }
  const request = async (step, path, init = {}, expected = [200], anonymous = false) => {
    phase = step; let response
    try { response = anonymous
      ? await boundedFetch(CORE_ORIGIN + '/mikka' + path, { ...init, redirect: 'error', headers: { origin: CORE_ORIGIN, 'cache-control': 'no-store', ...init.headers } })
      : await client.request(path, init) } catch (error) {
      const selection = selectionError(error)
      if (selection) throw selection
      throw new ProbeError('request_failed')
    }
    report.responses.push({ step, httpStatus: response.status })
    const body = await responseJson(response)
    if (!expected.includes(response.status)) throw new ProbeError('unexpected_status', response.status, closedBody(body))
    return { status: response.status, body }
  }
  const read = async (step, path) => (await request(step, path)).body
  const pin = async which => {
    const result = await request('version_' + which, '/api/version', {}, [200], true)
    check(result.body?.build === source, 'build_changed'); report.checks['version_' + which] = true
  }
  const pages = async (workspaceId, tab, step) => {
    const items = [], cursors = new Set(); let cursor, historySince
    for (let index = 0; index < 10; index++) {
      const page = validatePage(await read(step + '_' + index, '/api/inbox?' + new URLSearchParams({ workspaceId, tab, limit: '100', ...(cursor ? { cursor } : {}) })), workspaceId, tab)
      check(!historySince || page.historySince === historySince); historySince = page.historySince
      items.push(...page.items)
      if (page.nextCursor === null) {
        const ids = items.map(item => tab === 'done' ? item.completion.id : `${item.type}:${item.id}`)
        check(new Set(ids).size === ids.length)
        return { items, complete: true, pages: index + 1, historySince }
      }
      check(!cursors.has(page.nextCursor)); cursors.add(page.nextCursor); cursor = page.nextCursor
    }
    return { items, complete: false, pages: 10, historySince }
  }
  const ownItems = async (tab, step) => {
    const page = await pages(personalWorkspaceId, tab, step)
    check(page.complete, 'inventory_incomplete')
    const rows = page.items.filter(item => item.type === 'suggestion' && item.id === suggestionId)
    check(rows.every(item => item.ownerId === ownerId && item.source === 'github'), 'fixture_binding_failed')
    return rows
  }
  const command = async (action, expectedChanged, until, step = action) => {
    const result = await request(step, '/api/inbox', post({ workspaceId: personalWorkspaceId, type: 'suggestion', id: suggestionId, action,
      ...(until ? { until } : {}) }))
    check(typeof result.body?.changed === 'boolean' && (expectedChanged === null || result.body.changed === expectedChanged), 'command_mismatch')
  }
  const checkpoint = async state => {
    try { await writeReceipt(inboxBindingJournal({ schema: 1, purpose: 'mikka1820-exact-suggestion', applicationSha: source,
      headSha: selected.headSha, window: { commentId: selected.window.commentId, markerSha256: selected.window.markerSha256 },
      driverRunId: Number(env.GITHUB_RUN_ID), driverAttempt: Number(env.GITHUB_RUN_ATTEMPT), ownerHash: digest(ownerId),
      workspaceId: personalWorkspaceId, suggestionId, originalWorkspaceId, selectedWorkspaceId, sessionIdHash,
      priorSessionIdHashes, recoveryOf: recovery?.reference ?? null,
      ...boundFixture, state, observedAt: new Date(now()).toISOString() })) }
    catch { throw new ProbeError('receipt_failed') }
    if (['bound_before_mutation', 'recovery_bound_before_cleanup'].includes(state)) bindingJournaled = true
  }
  const githubRead = async path => {
    check(/^\/repos\/alexj11324\/Mikka-handoff\/issues\/(?:[1-9]\d*|(?:events|comments)\/[1-9]\d*)$/.test(path)
      || /^\/users\/[a-zA-Z0-9-]{1,39}$/.test(path), 'fixture_binding_failed')
    let response
    try { response = await boundedFetch(GITHUB_API + path, { method: 'GET', redirect: 'error',
      headers: { accept: 'application/vnd.github+json', 'cache-control': 'no-store', 'x-github-api-version': '2022-11-28' } }) }
    catch { throw new ProbeError('request_failed') }
    report.responses.push({ step: 'public_github_metadata', httpStatus: response.status })
    const body = await responseJson(response)
    if (response.status !== 200) throw new ProbeError('unexpected_status', response.status, { errorCode: 'other' })
    return body
  }
  try {
    selected = await selectTarget({ env, event, attestation, fetchImpl, now, expectedSelection: selection, assertTarget })
    if (!selected?.selected) {
      report.status = 'not_selected'; report.selection = selected
      return report
    }
    const target = selected.attestation
    check(target?.status === 'ready' && target.openIssues?.includes(1820) && SHA.test(target.applicationSha ?? ''), 'target_refused')
    source = target.applicationSha; report.applicationSha = source; report.driverRunId = target.driverRunId
    report.selection = { pr: selected.pr ?? 1822, headSha: selected.headSha, phase: selected.window.phase,
      ...(selected.purpose === 'inbox-1820-followup-selection' ? { featurePr: 1822, branch: selected.branch,
        originMergeSha: selected.originMergeSha, originHeadSha: selected.originHeadSha } : {}),
      commentId: selected.window.commentId, markerSha256: selected.window.markerSha256, expiresAt: selected.window.expiresAt }
    fixture = selected.window.phase === 'fixture' ? selected.window.fixture : undefined
    deadline = Date.now() + 240_000
    await lease()
    if (selected.window.phase === 'cleanup') {
      phase = 'recovery_proof'
      recovery = await readRecovery({ reference: selected.window.recovery, selected, env, fetchImpl: boundedFetch, now })
      report.recovery = { ...recovery.proof, reference: recovery.reference }
    }
    account = smokeAcceptanceAccount(env)
    client = createSessionClient(CORE_ORIGIN, async (url, init) => {
      const targetUrl = new URL(url), headers = new Headers(init.headers)
      check(targetUrl.origin === CORE_ORIGIN && targetUrl.pathname.startsWith('/mikka/api/'), 'target_refused')
      // A lease withdrawal must stop new business without stranding this
      // attempt's own journaled resources. Closing permits only those exact
      // cleanup commands, the saved workspace, and this session's logout.
      if (!['GET', 'HEAD'].includes(init.method ?? 'GET')) {
        if (closing) check(cleanupWriteAllowed(targetUrl.pathname, init), 'cleanup_failed')
        else await lease()
      }
      if (targetUrl.pathname === '/mikka/api/auth/get-session') targetUrl.searchParams.set('disableCookieCache', 'true')
      if (signInAttempted && !originalCookie && headers.get('cookie')) originalCookie = headers.get('cookie')
      return boundedFetch(targetUrl, { ...init, headers, redirect: 'error' })
    })
    await pin('before'); signInAttempted = true
    await request('sign_in', '/api/auth/sign-in/email', post({ ...account, rememberMe: false }))
    const identity = await read('session', '/api/auth/get-session?disableCookieCache=true')
    check(identity?.user?.email?.toLowerCase() === account.email.toLowerCase() && typeof identity.user.id === 'string'
      && identity.user.id && typeof identity.session?.id === 'string' && originalCookie, 'identity_failed')
    ownerId = identity.user.id; report.inventory.ownerHash = digest(ownerId)
    identitySessionId = identity.session.id; sessionIdHash = digest(identitySessionId)
    if (recovery) {
      phase = 'recovery_scope'
      const original = recovery.journal, settings = await read('recovery_workspace', '/api/workspace')
      check(original.ownerHash === digest(ownerId) && original.sessionIdHash !== sessionIdHash
        && settings?.currentUserId === ownerId && Array.isArray(settings.choices)
        && settings.choices.filter(row => row.kind === 'personal' && row.id === original.workspaceId).length === 1
        && [original.originalWorkspaceId, original.selectedWorkspaceId].every(id => settings.choices.some(row => row.id === id))
        && [original.originalWorkspaceId, original.selectedWorkspaceId].includes(settings.workspace?.id), 'recovery_scope_invalid')
      personalWorkspaceId = original.workspaceId; originalWorkspaceId = original.originalWorkspaceId
      selectedWorkspaceId = original.selectedWorkspaceId; suggestionId = original.suggestionId
      boundFixture = Object.fromEntries(['nonce', 'sourceUrl', 'occurredAt', 'action', 'required', 'externalSourceClosed',
        'sourceEventId', 'sourceIssueNumber'].map(key => [key, original[key]]))
      priorSessionIdHashes = [...new Set([original.sessionIdHash, ...original.priorSessionIdHashes])].sort()
      check(priorSessionIdHashes.length <= 8 && !priorSessionIdHashes.includes(sessionIdHash), 'recovery_scope_invalid')
      const sessions = await read('recovery_sessions', '/api/auth/list-sessions')
      check(Array.isArray(sessions) && sessions.length <= 100
        && sessions.every(row => row?.userId === ownerId && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 512), 'recovery_scope_invalid')
      for (const sessionHash of priorSessionIdHashes) {
        const matches = sessions.filter(row => typeof row?.id === 'string' && digest(row.id) === sessionHash)
        check(matches.length <= 1, 'recovery_scope_invalid')
        if (!matches.length) continue
        const old = matches[0]
        check(old.userId === ownerId && old.id !== identitySessionId && typeof old.token === 'string'
          && old.token.length >= 32 && old.token.length <= 512, 'recovery_scope_invalid')
        recoverySessions.push({ id: old.id, token: old.token }); recoveryTokens.add(old.token)
      }
      const [pending, snoozed, done] = await Promise.all(['pending', 'snoozed', 'done'].map(tab => ownItems(tab, 'recovery_' + tab)))
      check(pending.length + snoozed.length <= 1 && pending.length + snoozed.length + done.length > 0
        && [...pending, ...snoozed].every(row => row.pending && row.actions.includes('reject'))
        && done.every(row => row.completion.action === 'rejected' && row.completion.actorId === ownerId), 'recovery_scope_invalid')
      // This fresh window grants recovery, not another business probe. Record
      // its exact scope before any cleanup write; finally then finishes it even
      // if the new window expires while a response is in flight.
      await lease(); await checkpoint('recovery_bound_before_cleanup')
      report.recovery.originalSessionsAbsent = priorSessionIdHashes.length - recoverySessions.length
      report.recovery.priorState = snoozed.length ? 'snoozed' : pending.length ? 'pending' : 'done'
      report.apiStatus = 'cleanup_ready'
    } else {
      const teamSelection = await selectTeam(client, { ownerId }, value => { originalWorkspaceId = value })
      selectedWorkspaceId = teamSelection.workspaceId
      const settings = await read('workspace', '/api/workspace')
      check(settings?.currentUserId === ownerId && settings.workspace?.id === teamSelection.workspaceId
        && settings.workspace.kind === 'team' && Array.isArray(settings.choices), 'identity_failed')
      const choices = settings.choices
      check(choices.every(row => UUID.test(row.id ?? '') && ['personal', 'team'].includes(row.kind))
        && new Set(choices.map(row => row.id)).size === choices.length, 'identity_failed')
      const homes = choices.filter(row => row.kind === 'personal')
      check(homes.length === 1, 'identity_failed'); personalWorkspaceId = homes[0].id
      report.inventory.personalWorkspaceId = personalWorkspaceId
      report.inventory.fixtureRequest = { schema: 1, purpose: 'mikka1820-owner-github-fixture', nonce: randomUUID(),
        applicationSha: source, inventoryRunId: Number(env.GITHUB_RUN_ID), inventoryRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
        ownerHash: digest(ownerId), workspaceId: personalWorkspaceId, createdAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + 6 * 60 * 60_000).toISOString() }
      report.inventory.workspaceCount = choices.length; report.inventory.workspaces = []
      const scopes = [homes[0], ...choices.filter(row => row.id !== personalWorkspaceId)].slice(0, 32)
      report.inventory.workspaceDiscoveryComplete = scopes.length === choices.length
      for (const [index, workspace] of scopes.entries()) {
        const observation = { kind: workspace.kind, selectedTeam: workspace.id === teamSelection.workspaceId, tabs: {} }
        for (const tab of ['pending', 'snoozed', 'done']) {
          const page = await pages(workspace.id, tab, `inventory_${index}_${tab}`)
          observation.tabs[tab] = { count: page.items.length, suggestions: page.items.filter(item => item.type === 'suggestion').length,
            tasks: page.items.filter(item => item.type === 'task').length, complete: page.complete, pages: page.pages, historySince: page.historySince }
        }
        report.inventory.workspaces.push(observation)
      }
      report.coverage.inboxRead = 'normal_owner_all_tabs'
      const accounts = await read('linked_accounts', '/api/auth/list-accounts')
      check(Array.isArray(accounts) && accounts.every(row => typeof row?.providerId === 'string'
        && (row.userId === undefined || row.userId === ownerId)), 'identity_failed')
      const recipientIds = new Set(accounts.filter(row => row.providerId === 'github' && /^[1-9]\d*$/.test(row.accountId ?? '')).map(row => row.accountId))
      const integration = await request('github_connection', '/api/integrations/github', {}, [200, 401, 403, 409, 502, 503])
      const connection = integration.body
      check(connection?.viewerId === ownerId, 'identity_failed')
      check(connection.githubAccountId === undefined || connection.githubAccountId === null
        || /^[1-9]\d{0,15}$/.test(connection.githubAccountId), 'identity_failed')
      report.inventory.github = { httpStatus: integration.status, connected: connection.connected === true,
        configured: connection.configured === true, installed: connection.installed === true,
        testRepositoryAuthorized: connection.repositories?.some(row => row.fullName === REPOSITORY) === true,
        source: connection.source === 'cloud' ? 'cloud' : 'local', recipients: [...recipientIds].map(id => ({ id, source: 'sign_in' })) }
      if (connection.connected === true && typeof connection.githubAccountId === 'string' && /^[1-9]\d{0,15}$/.test(connection.githubAccountId)) {
        recipientIds.add(connection.githubAccountId)
        report.inventory.github.recipients.push({ id: connection.githubAccountId, source: 'verified_integration' })
      } else if (connection.connected === true && typeof connection.login === 'string' && /^[a-zA-Z0-9-]{1,39}$/.test(connection.login)) {
        const githubUser = await githubRead('/users/' + connection.login)
        check(positive(githubUser?.id) && githubUser.login?.toLowerCase() === connection.login.toLowerCase(), 'identity_failed')
        recipientIds.add(String(githubUser.id))
        report.inventory.github.recipients.push({ id: String(githubUser.id), source: 'plugin' })
      }

      // No model, publication, approval, GitHub sync or task mutation. The
      // explicit header pins only the already verified acceptance team. Other
      // accessible choices do not authorize additional Factory acceptance.
      const factory = await readInboxFactoryInventory({ workspaceId: teamSelection.workspaceId, request,
        deadline: deadline - 60_000, beforePage: lease, observe: value => { report.inventory.factory = value } })
      await lease()
      if (factory.summaries.some(row => row.kind === 'no_pr')) report.coverage.noPrNull = 'normal_owner_flow_null'
      if (factory.summaries.some(row => row.kind === 'pr' && row.sameReadback === true))
        report.coverage.cachedReviewSummary = 'handoff_complete_snapshot_readback'
      if (fixture) {
        phase = 'fixture_source'
        boundFixture = await verifyInboxFixture(fixture, { ownerId, personalWorkspaceId, recipientIds, githubRead, now,
          applicationSha: source, driverRunId: Number(env.GITHUB_RUN_ID), driverRunAttempt: Number(env.GITHUB_RUN_ATTEMPT) })
        // This existing product endpoint can write today's briefing and restore
        // Composio triggers. It is deliberately excluded from inventory, and is
        // used once only after this exact new external event is verified.
        report.checks.suggestionsReadMayWriteBriefingAndTriggers = true
        await lease()
        const suggestions = await read('fixture_suggestions', '/api/suggestions')
        check(Array.isArray(suggestions?.groups) && Array.isArray(suggestions.inProgress))
        const matches = suggestions.groups.flatMap(group => Array.isArray(group?.items) ? group.items : []).filter(item => item.source === 'github'
          && item.url === boundFixture.sourceUrl && item.action === boundFixture.action && item.required === boundFixture.required
          && item.occurredAt === boundFixture.occurredAt)
        check(matches.length === 1 && UUID.test(matches[0].id ?? ''), 'fixture_unavailable')
        check(!suggestions.inProgress.some(item => item.id === matches[0].id), 'fixture_binding_failed')
        suggestionId = matches[0].id
        const [pending] = await ownItems('pending', 'fixture_pending')
        check(pending?.pending === true && pending.rejectedAt === null && pending.snoozedUntil === null
          && ['reject', 'snooze'].every(action => pending.actions.includes(action)), 'fixture_binding_failed')
        check((await ownItems('done', 'fixture_history_before')).length === 0, 'fixture_binding_failed')
        await checkpoint('bound_before_mutation')
        report.checks.fixture = { suggestionId, ...boundFixture }
        live = inboxLiveSocket(await read('live_ticket', '/api/live/ticket?workspace=' + personalWorkspaceId), { ownerId, workspaceId: personalWorkspaceId, now, socketFactory })
        await live.ready()
        const until = new Date(now() + 120_000).toISOString(), snoozePush = live.expect()
        await command('snooze', true, until); await snoozePush(); await command('snooze', false, until, 'snooze_duplicate')
        check((await ownItems('pending', 'pending_after_snooze')).length === 0, 'command_mismatch')
        const [snoozed] = await ownItems('snoozed', 'snoozed_readback')
        check(snoozed?.snoozedUntil === until && snoozed.actions.includes('reopen'), 'command_mismatch')
        const reopenPush = live.expect()
        await command('reopen', true); await reopenPush(); await command('reopen', false, undefined, 'reopen_duplicate')
        check((await ownItems('snoozed', 'snoozed_after_reopen')).length === 0 && (await ownItems('pending', 'pending_after_reopen')).length === 1, 'command_mismatch')
        report.coverage.snoozeReopen = 'transition_idempotence_and_readback'
        const dueAt = now() + 20_000, due = new Date(dueAt).toISOString(), expiryPush = live.expect({ after: dueAt, timeout: 55_000 })
        await command('snooze', true, due, 'snooze_due')
        check((await ownItems('snoozed', 'due_before_expiry'))[0]?.snoozedUntil === due, 'command_mismatch')
        report.checks.expiryPush = await expiryPush()
        check((await ownItems('snoozed', 'snoozed_after_expiry')).length === 0 && (await ownItems('pending', 'pending_after_expiry')).length === 1, 'command_mismatch')
        report.coverage.snoozeExpiryPush = 'due_timer_push_and_single_readback'; report.checks.dueAt = due
        const rejectedAfter = now(), rejectPush = live.expect()
        await command('reject', true); await rejectPush(); await command('reject', false, undefined, 'reject_duplicate')
        check((await ownItems('pending', 'pending_after_reject')).length === 0, 'command_mismatch')
        const receipts = await ownItems('done', 'done_reject')
        check(receipts.length === 1 && receipts[0].completion.action === 'rejected' && receipts[0].completion.actorId === ownerId
          && receipts[0].rejectedBy === ownerId && iso(receipts[0].rejectedAt) && Date.parse(receipts[0].completion.at) >= rejectedAfter - 2_000
          && receipts[0].actions.includes('undo_reject'), 'receipt_mismatch')
        const receiptId = receipts[0].completion.id, undoPush = live.expect()
        await command('undo_reject', true); await undoPush(); await command('undo_reject', false, undefined, 'undo_duplicate')
        const restored = await ownItems('pending', 'pending_after_undo'), history = await ownItems('done', 'done_after_undo')
        check(restored.length === 1 && restored[0].rejectedAt === null && restored[0].rejectedBy === null
          && history.length === 1 && history[0].completion.id === receiptId, 'receipt_mismatch')
        report.coverage.rejectUndo = 'transition_idempotence_and_readback'; report.coverage.doneReceipt = 'actor_time_single_receipt_retained_after_undo'
        report.checks.completion = { id: receiptId, at: receipts[0].completion.at, action: 'rejected', actorMatchesOwner: true }
        await checkpoint('business_checks_passed')
      } else report.inventory.fixture = 'not_supplied_no_mutation'
      await pin('after'); report.apiStatus = 'passed'; report.status = 'partial'
    }
  } catch (error) { report.failure = { step: phase, ...failure(error) } }
  finally {
    closing = true
    const clean = async (step, work) => { try { await work() } catch (error) { report.cleanup.failures.push({ step, ...failure(error) }) } }
    if (client && bindingJournaled && suggestionId && boundFixture) await clean('own_suggestion', async () => {
      // A lost HTTP response is recovered by these same idempotent owner
      // commands, using only the source-bound UUID journaled before mutation.
      await command('reopen', null, undefined, 'cleanup_reopen')
      await command('reject', null, undefined, 'cleanup_reject')
      check((await ownItems('pending', 'cleanup_pending')).length === 0 && (await ownItems('snoozed', 'cleanup_snoozed')).length === 0, 'cleanup_failed')
      const receipts = await ownItems('done', 'cleanup_done')
      check(receipts.length >= 1 && receipts.every(row => row.completion.action === 'rejected' && row.completion.actorId === ownerId
        && row.rejectedBy === ownerId && iso(row.rejectedAt)), 'cleanup_failed')
      report.cleanup.ownSuggestionDismissed = true; report.cleanup.immutableReceiptsRetained = receipts.length
      report.cleanup.externalSourceAlreadyClosed = boundFixture.externalSourceClosed
      await checkpoint('cleaned')
    })
    if (live) await clean('live_socket', async () => { await live.close(); report.cleanup.liveClosed = true })
    if (client && recovery && bindingJournaled) await clean('original_sessions', async () => {
      let revoked = 0
      for (const old of recoverySessions) {
        const result = await read('recovery_revoke_session', '/api/auth/list-sessions')
        check(Array.isArray(result) && result.length <= 100, 'cleanup_failed')
        const current = result.filter(row => row?.id === old.id)
        check(current.length <= 1 && current.every(row => row.userId === ownerId && row.id !== identitySessionId && row.token === old.token), 'cleanup_failed')
        if (current.length) {
          const result = await request('recovery_revoke_session', '/api/auth/revoke-session', post({ token: old.token }))
          check(result.body?.status === true, 'cleanup_failed')
        }
        const remaining = await read('recovery_session_readback', '/api/auth/list-sessions')
        check(Array.isArray(remaining) && remaining.length <= 100 && !remaining.some(row => row?.id === old.id || row?.token === old.token), 'cleanup_failed')
        revoked++; recoveryTokens.delete(old.token); old.token = ''
      }
      report.cleanup.originalSessionsRevoked = revoked
    })
    if (client && ownerId && originalWorkspaceId && (!recovery || bindingJournaled)) await clean('workspace_restore', async () => {
      await restoreWorkspace(client, ownerId, originalWorkspaceId); report.cleanup.workspaceRestored = true
    })
    if (client && signInAttempted) {
      await clean('sign_out', async () => { await request('sign_out', '/api/auth/sign-out', post({})); report.cleanup.signOutAccepted = true })
      await clean('original_cookie', async () => {
        check(originalCookie, 'cleanup_failed')
        const response = await boundedFetch(CORE_ORIGIN + '/mikka/api/auth/get-session?disableCookieCache=true', {
          method: 'GET', headers: { origin: CORE_ORIGIN, cookie: originalCookie, 'cache-control': 'no-store' }, redirect: 'error' })
        const body = await responseJson(response)
        if (!(response.status === 401 || response.status === 200 && body === null))
          throw new ProbeError('cleanup_failed', response.status, closedBody(body))
        report.cleanup.originalCookieRejected = true
      })
    }
    client?.clear(); originalCookie = ''; recoveryTokens.clear(); recoverySessions.forEach(row => { row.token = ''; row.id = '' })
    if (account) { account.email = ''; account.password = '' }
    if (source) await clean('closing_build', () => pin('closing'))
    report.cleanup.status = report.cleanup.failures.length ? 'failed' : 'passed'
    if (report.cleanup.failures.length) report.status = 'failed'
    if (report.apiStatus === 'passed' && report.cleanup.status === 'passed') {
      report.completeAcceptance = Object.values(report.coverage).every(value => !['not_exercised', 'not_observed'].includes(value))
      report.status = report.completeAcceptance ? 'passed' : 'partial'
    }
    if (report.apiStatus === 'cleanup_ready' && report.cleanup.status === 'passed') report.status = 'cleanup_passed'
    report.finishedAt = new Date(now()).toISOString()
  }
  return report
}

export function inboxProductionExitCode(report, selecting = false) {
  if (selecting) return ['selected', 'not_selected'].includes(report.status) ? 0 : 1
  if (report.status === 'not_selected' || report.status === 'passed' && report.completeAcceptance === true) return 0
  return ['partial', 'cleanup_passed'].includes(report.status) ? 2 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = 'self-hosted-production-report'
  const selecting = process.argv.includes('--select')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let report, coreRequired = false
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const attestation = selecting ? JSON.parse(await readFile(directory + '/attestation.json', 'utf8')) : await attestCoreProduction({ event })
    coreRequired = attestation.openIssues?.some(number => number !== 1820) === true
    if (selecting) report = await selectInboxAcceptance({ event, attestation })
    else {
      const selection = JSON.parse(await readFile(directory + '/inbox-selection.json', 'utf8'))
      report = await runInboxProduction({ event, attestation, selection,
        writeReceipt: async value => {
          const envelope = inboxJournalEnvelope(value), line = JSON.stringify(envelope)
          await appendFile(directory + '/inbox-journal.jsonl', line + '\n', { mode: 0o600 })
          await writeFile(directory + '/inbox-fixture.json', JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 })
          // Wait for the local stream flush before the first write. A later
          // recovery independently requires the completed remote job log; this
          // does not claim that artifact upload or remote persistence succeeded.
          await new Promise((resolve, reject) => process.stdout.write(INBOX_JOURNAL_PREFIX + line + '\n', error => error ? reject(error) : resolve()))
        } })
    }
  } catch (error) { report = { kind: 'mikka1820-production-api', status: 'failed', completeAcceptance: false,
    failure: inboxSelectionFailure(error) ?? { code: 'target_refused' } } }
  const text = JSON.stringify(report, null, 2) + '\n'
  await writeFile(directory + (selecting ? '/inbox-selection.json' : '/inbox.json'), text, { mode: 0o600 }); console.log(text)
  if (selecting && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    'selected=' + (report.selected === true) + '\ncore_required=' + coreRequired + '\n')
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '## Inbox production ' + (selecting ? 'selection' : 'API receipt') + '\n\nMissing fixture or summary coverage remains incomplete.\n\n```json\n' + text + '```\n')
  process.exitCode = inboxProductionExitCode(report, selecting)
}
