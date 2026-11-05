import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { assertDatabaseIdentity, loadEnvironment } from '../test-accounts/environment.mjs'
import { withTestAccounts } from '../test-accounts/session.mjs'

export const READ_ACTIONS = Object.freeze(['syncCoordinatorChat', 'syncIssueList', 'syncThreadList', 'pollIssue', 'pollIssueVersionSummaries'])
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
const referenceId = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
export class ReadCacheAcceptanceError extends Error {
  constructor(code, options) { super(code, options); this.name = 'ReadCacheAcceptanceError'; this.code = code }
}
const check = (condition, code) => { if (!condition) throw new ReadCacheAcceptanceError(code) }
export const publicFailure = error => ({ status: 'fail', code: error instanceof ReadCacheAcceptanceError ? error.code : 'read_cache_acceptance_failed' })

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

/** The business driver can only GET published read surfaces/assets, or POST a
 * named read action discovered from this same attested application's chunks. */
export function requestAllowed(path, init, environment, refs = {}) {
  try {
    if (typeof path !== 'string' || path.includes('\\')) return false
    const url = new URL(path, environment.origin), method = (init?.method ?? 'GET').toUpperCase()
    if (url.origin !== environment.origin || url.username || url.password || url.hash) return false
    const headers = new Headers(init?.headers)
    if (['authorization', 'cookie', 'host'].some(name => headers.has(name))) return false
    const base = environment.basePath, page = `${base}/en`
    if (method === 'POST') return url.pathname === page && !url.search
      && READ_ACTIONS.some(name => referenceId(refs[name]) && headers.get('next-action') === refs[name])
      && headers.get('content-type') === 'application/json' && headers.get('accept') === 'text/x-component'
    if (method !== 'GET' || init?.body !== undefined || headers.has('next-action')) return false
    if ([`${base}/api/version`, `${base}/api/auth/get-session`, `${base}/api/workspace/switcher`, `${base}/api/settings/issue-prefix`].includes(url.pathname)) return !url.search
    if (url.pathname === page) return [...url.searchParams].every(([key, value]) => ['issue', 'workspace'].includes(key) && uuid(value))
    if (url.pathname === `${page}/settings`) return [...url.searchParams].every(([key, value]) => key === 'section' && value === 'preferences' || key === 'workspace' && uuid(value))
    return chunkPath(url.href, environment) !== null
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
  const diagnostics = { pagesRead: 0, chunksRead: 0, found: [] }
  const add = raw => {
    const path = chunkPath(raw, environment)
    if (path && !queued.has(path) && queued.size < 3000) { queued.add(path); queue.push(path) }
  }
  const scan = source => {
    check(Buffer.byteLength(source) <= 8_000_000, 'public_asset_too_large')
    for (const match of source.matchAll(referenceCall)) if (READ_ACTIONS.includes(match[4])) refs[match[4]] = match[2]
    for (const match of source.matchAll(/(?:src|href)\s*=\s*(["'])([^"']+\.js(?:\?[^"']*)?)\1/g)) add(match[2].replaceAll('&amp;', '&'))
    for (const match of source.matchAll(/(["'])((?:static\/chunks\/|\/mikka\/_next\/static\/chunks\/)[^"'\\\r\n]+\.js(?:\?[^"'\\\r\n]*)?)\1/g)) add(match[2])
  }
  for (const page of [`${environment.basePath}/en`, ...(issueId ? [`${environment.basePath}/en?issue=${issueId}`] : []), `${environment.basePath}/en/settings?section=preferences`]) {
    const response = await request(page)
    check(response.ok, 'read_page_unavailable'); scan(await response.text()); diagnostics.pagesRead++
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
    const text = await response.text()
    check(Buffer.byteLength(text) <= 8_000_000, 'business_response_too_large')
    const value = decode(text)
    reads.push({ surface, scenario, actor, operation, httpStatus: response.status, httpBytes: Buffer.byteLength(text), jsonBytes: Buffer.byteLength(JSON.stringify(value) ?? ''), traceId })
    return value
  }
  return {
    request,
    action(name, args, surface, scenario) {
      check(READ_ACTIONS.includes(name) && referenceId(refs[name]), 'read_action_forbidden')
      return read(surface, scenario, name, `${environment.basePath}/en`, {
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
    const nextChat = success(await action('syncCoordinatorChat', [fixture.botId, restored ? null : c.version, continuation(c)], 'bot-chat', scenario)).chat
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
        for (const [index, id] of issueIds.entries()) await client.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope,"scopeSetBy",revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, ownerId, `Read cache task ${index}`, JSON.stringify(content), 'todo', 'normal', 'personal', 'user', index === 0 ? 3 : 1])
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
  const environment = await loadEnvironment(), runId = `read-cache-${randomUUID()}`, reads = []
  const startedAt = new Date().toISOString()
  const database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
  try {
    return await withTestAccounts({ environment, database, runId, workerId: 'read-cache', requestId: randomUUID() }, async scope => {
      const refs = {}, owner = createReadClient(scope.owner, environment, 'owner', reads, refs)
      const peer = createReadClient(scope.peer, environment, 'peer', reads, refs)
      const pin = async scenario => check((await owner.json(`${environment.basePath}/api/version`, 'environment', scenario)).build === environment.deploymentSha, 'application_build_changed')
      await pin('before')
      const workspace = await owner.json(`${environment.basePath}/api/workspace/switcher`, 'environment', 'scope')
      check(workspace.live?.ownerId === scope.owner.userId && uuid(workspace.workspace?.id), 'workspace_scope_invalid')
      const fixture = isolatedFixture(database, environment, scope, workspace.workspace.id)
      let discovery
      try {
        await fixture.setup()
        discovery = await discoverReadActions(owner.request, environment, fixture.issueIds[0])
        Object.assign(refs, discovery.refs)
        await exerciseReadCases({ owner, peer, fixture, environment })
        await pin('after')
      } finally { await fixture.cleanup() }
      return { version: 1, issue: 1372, status: 'pass', environment: { id: environment.id, origin: environment.origin, deploymentSha: environment.deploymentSha }, runId,
        startedAt, finishedAt: new Date().toISOString(), discovery: discovery.diagnostics, reads,
        fixtures: { issues: 3, threads: 3, chatMessages: 12, activityVersions: 3 },
        boundaries: { businessRequestWrites: false, modelExecution: false, browserExecution: false } }
    })
  } finally { await database.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runReadCacheAcceptance(), null, 2)) }
  catch (error) { console.error(JSON.stringify(publicFailure(error))); process.exitCode = 1 }
}
