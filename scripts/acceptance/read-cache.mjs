import { readRendererActions } from '../../lib/renderer-actions.mjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { isValidDeploymentId } from '../../lib/deployment-id.mjs'
import { assertDatabaseIdentity, EnvironmentError, loadEnvironment } from '../test-accounts/environment.mjs'
import { TestAccountError } from '../test-accounts/pool.mjs'
import { withTestAccounts } from '../test-accounts/session.mjs'
import { publishedReadActions, readRpcActions, rpcReadAllowed, rpcReadRequest, rpcReadResult } from './read-action-transport.mjs'

export const READ_ACTIONS = Object.freeze(['syncCoordinatorChat', 'syncIssueList', 'syncThreadList', 'pollIssue', 'pollIssueVersionSummaries'])
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
const referenceId = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
export class ReadCacheAcceptanceError extends Error {
  constructor(code, options) { super(code, options); this.name = 'ReadCacheAcceptanceError'; this.code = code }
}
const check = (condition, code) => { if (!condition) throw new ReadCacheAcceptanceError(code) }
// Public diagnostics are closed labels, never messages, stacks, SQL, response
// bodies or identity fields. An unregistered dependency code stays generic.
const accountFailureCodes = new Set(`ACCOUNT_ALREADY_EXISTS ACCOUNT_ALREADY_RESERVED ACCOUNT_BASELINE_FORBIDDEN ACCOUNT_DIRTY
ACCOUNT_FOOTPRINT_UNPROVEN ACCOUNT_IDENTITY_MISMATCH ACCOUNT_IDENTITY_UNVERIFIED ACCOUNT_INITIALIZATION_FAILED ACCOUNT_LOGIN_FAILED
ACCOUNT_POOL_DATABASE_ERROR ACCOUNT_PROVISIONING_FAILED ACCOUNT_PROVISIONING_NOT_AUTHORIZED ACCOUNT_RESERVATION_MISMATCH
ACCOUNT_SESSION_INVALID ACCOUNT_SESSION_STILL_ACTIVE ACCOUNT_SLOTS_INVALID ACTIVE_LEASE_PROTECTED ALREADY_CLEANED
CREDENTIAL_ENVIRONMENT_MISMATCH CREDENTIAL_REFERENCE_INVALID INCOMPLETE_PROVISIONING_QUARANTINED INVALID_REQUEST
LEASE_ALREADY_ATTACHED LEASE_ALREADY_COMPLETED LEASE_CLOSED LEASE_EXPIRED_UNPROVEN_STOP LEASE_LOST PARTIAL_PROVISIONING POOL_EXHAUSTED
PRIVATE_DIRECTORY_UNSAFE PRIVATE_FILE_UNSAFE QUARANTINED_ACCOUNT_PROTECTED REQUEST_CONFLICT RESOURCES_NOT_CLEANED
RESOURCE_ALREADY_EXISTS RESOURCE_NOT_OWNED RESOURCE_OWNERSHIP_UNPROVEN RESOURCE_OWNER_MISMATCH RESOURCE_STILL_PRESENT RESOURCE_TYPE_FORBIDDEN
SESSION_REVOCATION_NOT_AUTHORIZED SESSION_STATE_RETENTION_FAILED STALE_LEASE TEST_ACCOUNT_COOKIE_INVALID TEST_ACCOUNT_COOKIE_ORIGIN_MISMATCH
TEST_ACCOUNT_CREDENTIAL_OVERRIDE_FORBIDDEN TEST_ACCOUNT_FOREIGN_ORIGIN TEST_ACCOUNT_HTTP_FAILED TEST_ACCOUNT_RESPONSE_INCOMPLETE
TEST_ACCOUNT_RESPONSE_TOO_LARGE TEST_ACCOUNT_SESSION_FAILED`.split(/\s+/))
const environmentFailureCodes = new Set(`ACTUAL_DATABASE_MISMATCH ATTESTATION_CHALLENGE_INVALID AUTH_ORIGIN_MISMATCH
DATABASE_ATTESTATION_UNAVAILABLE DATABASE_FALLBACK_MISMATCH DATABASE_IDENTITY_MISMATCH DATABASE_IDENTITY_UNAVAILABLE
DATABASE_TARGET_CONFIGURATION_REQUIRED DATABASE_TARGET_INVALID DATABASE_TARGET_MISMATCH DATABASE_URL_INVALID DATABASE_URL_REQUIRED
DEPLOYED_ENVIRONMENT_REQUIRES_APPROVAL DEPLOYMENT_ATTESTATION_REJECTED DEPLOYMENT_IDENTITY_MISMATCH DEPLOYMENT_IDENTITY_UNAVAILABLE
DEPLOYMENT_SHA_MISMATCH ENVIRONMENT_CAPABILITIES_INVALID ENVIRONMENT_DATABASE_FORBIDDEN ENVIRONMENT_DESCRIPTOR_INVALID
ENVIRONMENT_FILE_REQUIRED ENVIRONMENT_FILE_UNREADABLE ENVIRONMENT_FILE_UNSAFE ENVIRONMENT_KIND_FORBIDDEN ENVIRONMENT_ORIGIN_FORBIDDEN
ENVIRONMENT_ORIGIN_INVALID EXTERNAL_MAIL_FORBIDDEN EXTERNAL_SERVICE_CREDENTIALS_FORBIDDEN LOCAL_DATABASE_REQUIRED PREVIEW_APPROVAL_REQUIRED
HTTP_RUNNER_REQUIRES_HTTP_ORIGIN OWNED_HTTP_SERVER_START_TIMEOUT OWNED_HTTP_SERVER_EXITED`.split(/\s+/))
const sqlStates = new Set(['08001', '08006', '22P02', '23502', '23503', '23505', '23514', '40001', '40P01', '42601', '42703', '42P01', '53300', '55000', '57014'])
const stages = new Set(['environment', 'accounts', 'version-before', 'workspace', 'fixture-setup', 'action-discovery', 'read-cases', 'version-after', 'fixture-cleanup', 'database-close'])

export class ReadCacheDiagnosticError extends Error {
  constructor(cause, evidence) {
    super('read_cache_acceptance_failed', { cause })
    this.name = 'ReadCacheDiagnosticError'
    this.evidence = {
      stage: stages.has(evidence.stage) ? evidence.stage : 'unknown',
      completedReads: Number.isSafeInteger(evidence.completedReads) && evidence.completedReads >= 0 ? evidence.completedReads : 0,
      fixtureCleanup: ['not-started', 'pending', 'succeeded', 'failed'].includes(evidence.fixtureCleanup) ? evidence.fixtureCleanup : 'unobserved',
      // A callback/finally existing is not evidence of a released lease.
      leaseCleanup: evidence.leaseCleanup === 'released-clean' ? 'released-clean' : 'unobserved',
    }
  }
}

export function publicFailure(error) {
  const evidence = error instanceof ReadCacheDiagnosticError ? error.evidence : {}
  if (error instanceof ReadCacheDiagnosticError) error = error.cause
  let code = 'read_cache_acceptance_failed'
  if (error instanceof ReadCacheAcceptanceError
    || error instanceof TestAccountError && accountFailureCodes.has(error.code)
    || error instanceof EnvironmentError && environmentFailureCodes.has(error.code)) code = error.code
  const result = { status: 'fail', code, ...evidence }
  if (error instanceof Error && sqlStates.has(error.code)) result.sqlState = error.code
  for (const kind of [TypeError, SyntaxError, RangeError, ReferenceError]) if (error instanceof kind) result.errorType = kind.name
  if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) result.errorType = error.name
  return result
}

function chunkPath(value, environment) {
  try {
    if (typeof value !== 'string' || value.includes('\\')) return null
    const raw = value.startsWith('static/chunks/') ? `${environment.basePath}/_next/${value}` : value
    const url = new URL(raw, environment.origin)
    if (url.origin !== environment.origin || url.username || url.password || url.hash) return null
    const prefix = `${environment.basePath}/_next/static/chunks/`
    if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith('.js')) return null
    const parts = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent)
    if (parts.some(part => !part || part === '.' || part === '..' || /[/\\]/.test(part))) return null
    return url.pathname + url.search
  } catch { return null }
}

/** Only the public production skew pin is accepted, never arbitrary query data. */
function webDeploymentPin(url) {
  if (!url.search) return ''
  const entries = [...url.searchParams]
  return entries.length === 1 && entries[0][0] === 'dpl' && isValidDeploymentId(entries[0][1]) ? entries[0][1] : null
}

function viteAssetPath(value, environment) {
  try {
    if (typeof value !== 'string' || value.includes('\\')) return null
    const url = new URL(value, environment.origin)
    if (url.origin !== environment.origin || url.username || url.password || url.hash || webDeploymentPin(url) === null) return null
    return new RegExp(`^${environment.basePath}/assets/[A-Za-z0-9_-]+\\.js$`).test(url.pathname) ? url.pathname + url.search : null
  } catch { return null }
}

/** The business driver can only GET published read surfaces/assets, or POST a
 * named read action discovered from this same attested application's chunks. */
export function requestAllowed(path, init, environment, refs = {}) {
  try {
    if (typeof path !== 'string' || path.includes('\\')) return false
    const url = new URL(path, environment.origin), method = (init?.method ?? 'GET').toUpperCase()
    if (url.origin !== environment.origin || url.username || url.password || url.hash) return false
    const headers = new Headers(init?.headers)
    if (['authorization', 'cookie', 'host'].some(name => headers.has(name))) return false
    const base = environment.basePath, page = base
    if (method === 'POST' && url.pathname === `${base}/api/rpc`) return !url.search && rpcReadAllowed(init, environment, refs)
    if (method === 'POST') return url.pathname === page && !url.search
      && READ_ACTIONS.some(name => referenceId(refs[name]) && headers.get('next-action') === refs[name])
      && headers.get('content-type') === 'application/json' && headers.get('accept') === 'text/x-component'
    if (method !== 'GET' || init?.body !== undefined || headers.has('next-action') || headers.has('x-mikka-rpc')) return false
    if ([`${base}/api/version`, `${base}/api/auth/get-session`, `${base}/api/workspace/switcher`, `${base}/api/settings/issue-prefix`].includes(url.pathname)) return !url.search
    if (url.pathname === page) return [...url.searchParams].every(([key, value]) => ['issue', 'workspace'].includes(key) && uuid(value))
    if (url.pathname === `${page}/settings`) return [...url.searchParams].every(([key, value]) => key === 'section' && value === 'preferences' || key === 'workspace' && uuid(value))
    return [`${base}/renderer-manifest.json`, `${base}/renderer-actions.json`].includes(url.pathname) && webDeploymentPin(url) !== null
      || chunkPath(url.href, environment) !== null || viteAssetPath(url.href, environment) !== null
  } catch { return false }
}

const identifier = String.raw`[$A-Z_a-z][$\w]*`
const member = identifier + String.raw`(?:\s*(?:\.\s*` + identifier + String.raw`|\[\s*(?:"` + identifier + String.raw`"|'` + identifier + String.raw`')\s*\]))*`
const referenceCall = new RegExp(String.raw`(?:\bcreateServerReference|\[\s*(?:"createServerReference"|'createServerReference')\s*\])\s*\)?\s*\(\s*(["'])([a-f0-9]{40,64})\1\s*,\s*`
  + member + String.raw`\s*,\s*(?:void\s+0|undefined)\s*,\s*` + member + String.raw`\s*,\s*(["'])([A-Za-z]+)\3\s*\)`, 'g')

/** Read Next dev/production public chunks, without evaluating JavaScript or
 * inspecting private server manifests. A finite scan is not a polling loop. */
export async function discoverReadActions(request, environment, issueId) {
  const queue = [], queued = new Set(), seen = new Set(), refs = {}
  const vitePins = new Set()
  const diagnostics = { pagesRead: 0, chunksRead: 0, found: [] }
  const add = raw => {
    const path = chunkPath(raw, environment)
    if (path && !queued.has(path) && queued.size < 3000) { queued.add(path); queue.push(path) }
  }
  const scan = source => {
    check(Buffer.byteLength(source) <= 8_000_000, 'public_asset_too_large')
    for (const match of source.matchAll(referenceCall)) if (READ_ACTIONS.includes(match[4])) refs[match[4]] = match[2]
    for (const match of source.matchAll(/(?:src|href)\s*=\s*(["'])([^"']+\.js(?:\?[^"']*)?)\1/g)) {
      const path = match[2].replaceAll('&amp;', '&')
      const entry = viteAssetPath(path, environment)
      if (entry) vitePins.add(webDeploymentPin(new URL(entry, environment.origin)))
      add(path)
    }
    for (const match of source.matchAll(/(["'])((?:static\/chunks\/|\/mikka\/_next\/static\/chunks\/)[^"'\\\r\n]+\.js(?:\?[^"'\\\r\n]*)?)\1/g)) add(match[2])
  }
  // Match normal account initialization and API reads. Switching to another
  // locale can rename a generated personal workspace during a page read.
  for (const page of [environment.basePath, ...(issueId ? [`${environment.basePath}?issue=${issueId}`] : []), `${environment.basePath}/settings?section=preferences`]) {
    const response = await request(page)
    check(response.ok, 'read_page_unavailable'); scan(await response.text()); diagnostics.pagesRead++
  }
  if (vitePins.size) {
    check(vitePins.size === 1, 'read_action_reference_missing')
    const [pin] = vitePins
    const response = await readRendererActions(request, environment.basePath, pin)
    check(response.ok && response.headers.get('content-type')?.includes('application/json'), 'public_action_manifest_unavailable')
    const source = await response.text()
    check(Buffer.byteLength(source) <= 8_000_000, 'public_asset_too_large')
    let published
    try { published = publishedReadActions(JSON.parse(source)) }
    catch (error) { throw new ReadCacheAcceptanceError('read_action_reference_missing', { cause: error }) }
    return { refs: published, diagnostics: { ...diagnostics, transport: 'rpc', manifestsRead: 1, found: [...READ_ACTIONS] } }
  }
  while (queue.length && seen.size < 200 && READ_ACTIONS.some(name => !refs[name])) {
    const batch = queue.splice(0, Math.min(12, 200 - seen.size))
    for (const path of batch) seen.add(path)
    // Each rejected request remains a failure: missing assets cannot become a pass.
    const results = await Promise.allSettled(batch.map(async path => {
      const response = await request(path)
      check(response.ok, 'public_asset_unavailable'); scan(await response.text()); diagnostics.chunksRead++
    }))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  diagnostics.found = READ_ACTIONS.filter(name => referenceId(refs[name]))
  check(diagnostics.found.length === READ_ACTIONS.length, 'read_action_reference_missing')
  return { refs, diagnostics }
}

/** Decode only plain read results in Flight. Length-delimited UTF-8 text rows
 * matter here: task/chat bodies exceed React's inline-string threshold. */
export function actionResult(text) {
  const bytes = Buffer.from(text), rows = new Map(), errors = new Set()
  check(bytes.length <= 8_000_000, 'action_response_too_large')
  for (let at = 0; at < bytes.length;) {
    if (bytes[at] === 10) { at++; continue }
    const colon = bytes.indexOf(58, at), newline = bytes.indexOf(10, at)
    if (colon < 0 || newline >= 0 && colon > newline) { if (newline < 0) break; at = newline + 1; continue }
    const id = bytes.subarray(at, colon).toString()
    if (!/^[0-9a-f]+$/.test(id)) { if (newline < 0) break; at = newline + 1; continue }
    at = colon + 1
    if (bytes[at] === 84) {
      const comma = bytes.indexOf(44, at), length = comma < 0 ? '' : bytes.subarray(at + 1, comma).toString()
      check(/^[0-9a-f]+$/.test(length), 'action_text_invalid')
      const end = comma + 1 + parseInt(length, 16)
      check(end <= bytes.length, 'action_text_invalid')
      rows.set(id, bytes.subarray(comma + 1, end).toString()); at = end; continue
    }
    const end = bytes.indexOf(10, at), line = bytes.subarray(at, end < 0 ? bytes.length : end).toString()
    if (line.startsWith('E')) errors.add(id)
    else { try { rows.set(id, JSON.parse(line)) } catch { /* Flight import/debug rows are not application data. */ } }
    at = end < 0 ? bytes.length : end + 1
  }
  const resolve = (value, depth = 0, visiting = new Set()) => {
    check(depth <= 40, 'action_reference_invalid')
    if (typeof value === 'string') {
      const reference = /^\$@?([0-9a-f]+)$/.exec(value)
      if (reference) {
        const id = reference[1]
        check(!errors.has(id), 'action_server_error')
        check(rows.has(id) && !visiting.has(id), 'action_reference_invalid')
        return resolve(rows.get(id), depth + 1, new Set([...visiting, id]))
      }
      if (value === '$undefined') return undefined
      if (value.startsWith('$$')) return value.slice(1)
      if (value.startsWith('$D')) return value.slice(2)
    }
    if (Array.isArray(value)) return value.map(item => resolve(item, depth + 1, visiting))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, depth + 1, visiting)]))
    return value
  }
  check(rows.get('0') && Object.hasOwn(rows.get('0'), 'a'), 'action_result_missing')
  return resolve(rows.get('0').a)
}

export function createReadClient(account, environment, actor, reads, refs = {}) {
  const request = async (path, init = {}) => {
    check(requestAllowed(path, init, environment, refs), 'business_request_forbidden')
    return account.request(path, { ...init, cache: 'no-store' })
  }
  const read = async (surface, scenario, operation, path, init, decode) => {
    const traceId = randomBytes(16).toString('hex'), spanId = randomBytes(8).toString('hex')
    const response = await request(path, { ...init, headers: { ...init?.headers, traceparent: `00-${traceId}-${spanId}-01` } })
    check(response.ok, 'business_read_failed')
    if (init?.headers?.['x-mikka-rpc']) check(response.headers.get('content-type')?.includes('application/json'), 'read_action_response_invalid')
    const text = await response.text()
    check(Buffer.byteLength(text) <= 8_000_000, 'business_response_too_large')
    const value = decode(text)
    reads.push({ surface, scenario, actor, operation, httpStatus: response.status, httpBytes: Buffer.byteLength(text), jsonBytes: Buffer.byteLength(JSON.stringify(value) ?? ''), traceId })
    return value
  }
  return {
    request,
    action(name, args, surface, scenario) {
      check(READ_ACTIONS.includes(name) && (referenceId(refs[name]) || refs[name] === readRpcActions[name]), 'read_action_forbidden')
      if (refs[name] === readRpcActions[name]) {
        const { path, init } = rpcReadRequest(name, args, environment, refs)
        return read(surface, scenario, name, path, init, text => {
          try { return rpcReadResult(JSON.parse(text)) }
          catch (error) { throw new ReadCacheAcceptanceError('read_action_response_invalid', { cause: error }) }
        })
      }
      return read(surface, scenario, name, environment.basePath, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/x-component', 'next-action': refs[name] }, body: JSON.stringify(args),
      }, actionResult)
    },
    json(path, surface, scenario) { return read(surface, scenario, path.replace(environment.basePath, ''), path, undefined, JSON.parse) },
  }
}

const success = result => { check(result && !result.error, 'read_action_refused'); return result }
const snapshot = result => success(result).snapshot
const clone = value => JSON.parse(JSON.stringify(value))
const continuation = chat => ({ ...chat.continuation, sourceIds: Object.keys(chat.sources ?? {}), artifactIds: Object.keys(chat.artifacts ?? {}) })

/** Actual HTTP cases; fixture edits are separate isolated-database operations,
 * never HTTP business mutations, messages, dispatches or provider calls. */
export async function exerciseReadCases({ owner, peer, fixture, environment }) {
  const action = (name, args, surface, scenario, client = owner) => client.action(name, args, surface, scenario)
  const chat = success(await action('syncCoordinatorChat', [fixture.botId], 'bot-chat', 'cold')).chat
  check(chat?.items?.length > 0 && chat.continuation, 'chat_fixture_missing')
  const issues = snapshot(await action('syncIssueList', [], 'task-list', 'cold'))
  const threads = snapshot(await action('syncThreadList', [], 'thread-list', 'cold'))
  check(fixture.issueIds.every(id => issues.items?.some(row => row.id === id)), 'issue_fixture_missing')
  check(fixture.runIds.every(id => threads.items?.some(row => row.id === id)), 'thread_fixture_missing')
  const detail = success(await action('pollIssue', [fixture.issueIds[0]], 'task-detail', 'cold'))
  const history = snapshot(await action('pollIssueVersionSummaries', [fixture.issueIds[0]], 'task-activity', 'cold'))
  check(detail.issue?.content && history.items?.length === 3, 'detail_fixture_missing')
  const prefixPath = `${environment.basePath}/api/settings/issue-prefix`
  const prefix = await owner.json(prefixPath, 'settings', 'cold')
  check(typeof prefix.suggested === 'string' && Array.isArray(prefix.teamKeys), 'settings_read_invalid')

  for (const scenario of ['warm', 'reload-restored']) {
    const restored = scenario === 'reload-restored'
    const c = clone(chat), i = clone(issues), t = clone(threads), h = clone(history), d = clone(detail)
    const nextChat = success(await action('syncCoordinatorChat', [fixture.botId, restored ? undefined : c.version, continuation(c)], 'bot-chat', scenario)).chat
    check(restored ? Number.isInteger(nextChat.after) : nextChat.unchanged === true, 'chat_cursor_not_used')
    check(snapshot(await action('syncIssueList', [i.version, i.positions], 'task-list', scenario)).unchanged === true, 'issue_cursor_not_used')
    check(snapshot(await action('syncThreadList', [t.version, t.positions], 'thread-list', scenario)).unchanged === true, 'thread_cursor_not_used')
    check(success(await action('pollIssue', [fixture.issueIds[0], d.version], 'task-detail', scenario)).unchanged === true, 'detail_cursor_not_used')
    check(snapshot(await action('pollIssueVersionSummaries', [fixture.issueIds[0], h.version, h.positions], 'task-activity', scenario)).unchanged === true, 'activity_cursor_not_used')
    const nextPrefix = await owner.json(prefixPath, 'settings', scenario)
    check(JSON.stringify(nextPrefix) === JSON.stringify(prefix), 'settings_read_changed')
  }

  check((await action('syncCoordinatorChat', [fixture.botId, chat.version, continuation(chat)], 'bot-chat', 'peer-denied', peer)).error === 'botNotFound', 'peer_chat_visible')
  check((await action('pollIssue', [fixture.issueIds[0], detail.version], 'task-detail', 'peer-denied', peer)).error === 'issueNotFound', 'peer_issue_visible')
  const peerIssues = snapshot(await action('syncIssueList', [issues.version, issues.positions], 'task-list', 'peer-isolation', peer))
  const peerThreads = snapshot(await action('syncThreadList', [threads.version, threads.positions], 'thread-list', 'peer-isolation', peer))
  check(!peerIssues.items?.some(row => fixture.issueIds.includes(row.id)) && !peerThreads.items?.some(row => fixture.runIds.includes(row.id)), 'peer_list_visible')

  await fixture.change()
  const chatDelta = success(await action('syncCoordinatorChat', [fixture.botId, chat.version, continuation(chat)], 'bot-chat', 'one-row-delta')).chat
  const issueDelta = snapshot(await action('syncIssueList', [issues.version, issues.positions], 'task-list', 'one-row-delta'))
  const threadDelta = snapshot(await action('syncThreadList', [threads.version, threads.positions], 'thread-list', 'one-row-delta'))
  const detailDelta = success(await action('pollIssue', [fixture.issueIds[0], detail.version], 'task-detail', 'changed'))
  const historyDelta = snapshot(await action('pollIssueVersionSummaries', [fixture.issueIds[0], history.version, history.positions], 'task-activity', 'one-row-delta'))
  check(Number.isInteger(chatDelta.after) && chatDelta.items?.some(item => item.position === 13), 'chat_delta_invalid')
  check(issueDelta.delta === true && issueDelta.items?.length === 1 && issueDelta.items[0].id === fixture.issueIds[0], 'issue_delta_invalid')
  check(threadDelta.delta === true && threadDelta.items?.length === 1 && threadDelta.items[0].id === fixture.runIds[0], 'thread_delta_invalid')
  check(detailDelta.issue?.title === 'Read cache changed' && historyDelta.delta === true && historyDelta.items?.length === 1, 'detail_delta_invalid')

  await fixture.remove()
  check((await action('pollIssue', [fixture.issueIds[0], detailDelta.version], 'task-detail', 'deleted')).error === 'issueNotFound', 'deleted_detail_visible')
  check((await action('pollIssueVersionSummaries', [fixture.issueIds[0], historyDelta.version, historyDelta.positions], 'task-activity', 'deleted')).error === 'issueNotFound', 'deleted_activity_visible')
  const afterIssues = snapshot(await action('syncIssueList', [issueDelta.version, issueDelta.positions], 'task-list', 'deleted'))
  const afterThreads = snapshot(await action('syncThreadList', [threadDelta.version, threadDelta.positions], 'thread-list', 'deleted'))
  const afterChat = success(await action('syncCoordinatorChat', [fixture.botId, chatDelta.version, continuation(chat)], 'bot-chat', 'deleted')).chat
  check(afterIssues.positions && !afterIssues.positions.some(row => row.id === fixture.issueIds[0]), 'deleted_issue_manifest_invalid')
  check(afterThreads.positions && !afterThreads.positions.some(row => row.id === fixture.runIds[0]), 'deleted_thread_manifest_invalid')
  check(Array.isArray(afterChat.items) && !afterChat.items.some(item => item.position === 1) && !Number.isInteger(afterChat.after), 'deleted_chat_prefix_reused')
}

function isolatedFixture(database, environment, scope, workspaceId) {
  const ownerId = scope.owner.userId, botId = randomUUID(), agentId = randomUUID()
  const issueIds = Array.from({ length: 3 }, () => randomUUID()), runIds = Array.from({ length: 3 }, () => randomUUID())
  const messageIds = Array.from({ length: 13 }, () => randomUUID()), versionIds = Array.from({ length: 4 }, () => randomUUID())
  const resources = [
    ['bots', botId], ['agents', agentId], ...issueIds.map(id => ['issues', id]), ...runIds.map(id => ['agent_runs', id]),
    ...messageIds.map(id => ['coordinator_messages', id]), ...versionIds.map(id => ['issue_versions', id]),
  ]
  const reserved = []
  const content = { type: 'doc', content: Array.from({ length: 24 }, () => ({ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic read-cache document. '.repeat(40) }] })) }
  const message = position => ({ role: position % 2 ? 'user' : 'assistant', ...(position % 2 ? {} : { mikkaStreamId: `read-cache-${position}` }), content: `Synthetic message ${position}. `.repeat(200) })
  const transaction = async work => {
    await scope.assertActive()
    const client = await database.connect()
    try {
      await assertDatabaseIdentity(client, environment)
      await client.query('BEGIN')
      try { await work(client); await scope.assertActive(); await client.query('COMMIT') }
      catch (error) { await client.query('ROLLBACK'); throw error }
    } finally { client.release() }
  }
  return {
    botId, issueIds, runIds,
    async setup() {
      for (const [type, id] of resources) { await scope.recordResource({ type, id, ownerId }); reserved.push([type, id]) }
      await transaction(async client => {
        await client.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,$4)', [botId, ownerId, workspaceId, `Read cache ${botId}`])
        await client.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,$4)', [agentId, ownerId, `Read cache ${agentId}`, 'codex'])
        for (const [index, id] of issueIds.entries()) await client.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope,"scopeSetBy",revision,"workspaceId") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, ownerId, `Read cache task ${index}`, JSON.stringify(content), 'todo', 'normal', 'personal', 'user', index === 0 ? 3 : 1, workspaceId])
        for (const [index, id] of runIds.entries()) await client.query('INSERT INTO agent_runs(id,"userId","agentId","botId",status,prompt,"lastReply") VALUES($1,$2,$3,$4,$5,$6,$7)', [id, ownerId, agentId, botId, 'succeeded', `Synthetic finished thread ${index}`, 'Synthetic completed read fixture. '.repeat(60)])
        for (let index = 0; index < 12; index++) await client.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,$2,$3,$4,$5)', [messageIds[index], ownerId, botId, index + 1, JSON.stringify(message(index + 1))])
        for (let index = 0; index < 3; index++) await client.query('INSERT INTO issue_versions(id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$3)', [versionIds[index], issueIds[0], ownerId, index + 1, `Read cache revision ${index}`, JSON.stringify(content), 'todo', 'normal', 'user'])
      })
    },
    change: () => transaction(async client => {
      await client.query('UPDATE issues SET title=$1,revision=4 WHERE id=$2 AND "userId"=$3', ['Read cache changed', issueIds[0], ownerId])
      await client.query('UPDATE agent_runs SET "lastReply"=$1 WHERE id=$2 AND "userId"=$3', ['Changed synthetic reply', runIds[0], ownerId])
      await client.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,$2,$3,13,$4)', [messageIds[12], ownerId, botId, JSON.stringify(message(13))])
      await client.query('INSERT INTO issue_versions(id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id) VALUES($1,$2,$3,4,$4,$5,$6,$7,$8,$3)', [versionIds[3], issueIds[0], ownerId, 'Read cache changed', JSON.stringify(content), 'todo', 'normal', 'user'])
    }),
    remove: () => transaction(async client => {
      await client.query('DELETE FROM issue_versions WHERE id=ANY($1::uuid[]) AND "issueId"=$2 AND "userId"=$3', [versionIds, issueIds[0], ownerId])
      await client.query('DELETE FROM issues WHERE id=$1 AND "userId"=$2', [issueIds[0], ownerId])
      await client.query('DELETE FROM agent_runs WHERE id=$1 AND "userId"=$2', [runIds[0], ownerId])
      await client.query('DELETE FROM coordinator_messages WHERE id=$1 AND "userId"=$2 AND "botId"=$3', [messageIds[0], ownerId, botId])
    }),
    async cleanup() {
      await transaction(async client => {
        for (const table of ['coordinator_messages', 'issue_versions', 'agent_runs', 'issues', 'agents', 'bots']) {
          const ids = reserved.filter(([type]) => type === table).map(([, id]) => id)
          if (ids.length) await client.query(`DELETE FROM "${table}" WHERE id=ANY($1::uuid[]) AND "${table === 'bots' ? 'ownerId' : 'userId'}"=$2`, [ids, ownerId])
        }
      })
      for (const [type, id] of reserved) await scope.markResourceCleaned({ type, id })
    },
  }
}

/** Attach only to an existing, exact-SHA, attested disposable environment. */
export async function runReadCacheAcceptance() {
  const reads = [], evidence = { stage: 'environment', fixtureCleanup: 'not-started', leaseCleanup: 'unobserved' }
  try {
    const environment = await loadEnvironment(), runId = `read-cache-${randomUUID()}`
    const startedAt = new Date().toISOString()
    const database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
    let callbackError
    try {
      evidence.stage = 'accounts'
      const result = await withTestAccounts({ environment, database, runId, workerId: 'read-cache', requestId: randomUUID() }, async scope => {
        try {
          const refs = {}, owner = createReadClient(scope.owner, environment, 'owner', reads, refs)
          const peer = createReadClient(scope.peer, environment, 'peer', reads, refs)
          const pin = async scenario => check((await owner.json(`${environment.basePath}/api/version`, 'environment', scenario)).build === environment.deploymentSha, 'application_build_changed')
          evidence.stage = 'version-before'
          await pin('before')
          evidence.stage = 'workspace'
          const workspace = await owner.json(`${environment.basePath}/api/workspace/switcher`, 'environment', 'scope')
          check(workspace.live?.ownerId === scope.owner.userId && uuid(workspace.workspace?.id), 'workspace_scope_invalid')
          const fixture = isolatedFixture(database, environment, scope, workspace.workspace.id)
          let discovery
          try {
            evidence.stage = 'fixture-setup'
            evidence.fixtureCleanup = 'pending'
            await fixture.setup()
            evidence.stage = 'action-discovery'
            discovery = await discoverReadActions(owner.request, environment, fixture.issueIds[0])
            Object.assign(refs, discovery.refs)
            evidence.stage = 'read-cases'
            await exerciseReadCases({ owner, peer, fixture, environment })
            evidence.stage = 'version-after'
            await pin('after')
          } finally {
            const interruptedStage = evidence.stage
            evidence.stage = 'fixture-cleanup'
            let cleaned = false
            try { await fixture.cleanup(); cleaned = true }
            finally { evidence.fixtureCleanup = cleaned ? 'succeeded' : 'failed' }
            evidence.stage = interruptedStage
          }
          evidence.stage = 'accounts'
          return { version: 1, issue: 1372, status: 'pass', environment: { id: environment.id, origin: environment.origin, deploymentSha: environment.deploymentSha }, runId,
            startedAt, finishedAt: new Date().toISOString(), discovery: discovery.diagnostics, reads,
            fixtures: { issues: 3, threads: 3, chatMessages: 12, activityVersions: 3 },
            boundaries: { businessRequestWrites: false, modelExecution: false, browserExecution: false } }
        } catch (error) { callbackError = error; throw error }
      })
      // withTestAccounts has now awaited and verified the clean release.
      evidence.leaseCleanup = 'released-clean'
      return { ...result, cleanup: { fixtures: evidence.fixtureCleanup, lease: evidence.leaseCleanup } }
    } catch (error) {
      // The account finalizer can fail after a callback error. Keep that actual
      // failure and its cause; do not mislabel it as a completed fixture read.
      if (callbackError && error !== callbackError) evidence.stage = 'accounts'
      throw error
    } finally {
      const interruptedStage = evidence.stage
      evidence.stage = 'database-close'
      await database.end()
      evidence.stage = interruptedStage
    }
  } catch (error) {
    throw new ReadCacheDiagnosticError(error, { ...evidence, completedReads: reads.length })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runReadCacheAcceptance(), null, 2)) }
  catch (error) { console.error(JSON.stringify(publicFailure(error))); process.exitCode = 1 }
}
