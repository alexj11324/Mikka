import { AsyncLocalStorage } from 'node:async_hooks'
import { ActionFailureError } from './lib/action-error.mjs'
import { WorkspaceError } from './lib/workspace-error.mjs'

export const fixture = new AsyncLocalStorage()
const action = new AsyncLocalStorage()
const S = () => { const value = fixture.getStore(); if (!value) throw new Error('fixture context required'); return value }
const record = (event, extra = {}) => { const state = S(); state.events.push({ index: state.events.length, event, action: action.getStore() ?? null, ...extra }) }
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
export const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const home = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const team = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const earlyActions = ['task-runs.pollTaskRuns', 'task-runs.syncThreadList', 'coordinator.pollBotChatSummaries']
export function makeFixture(options = {}) {
  const state = { owner, home, selected: home, authenticated: true, homeAvailable: true, revision: 7,
    deferWorkspace: false, failRevisionOnce: false, revisionFailed: false, events: [], revisionQueries: [], authCalls: [],
    completed: new Set(), earlyDone: deferred(), workspaceGate: deferred(), memo: new Map(), ...options }
  if (!state.deferWorkspace) state.workspaceGate.resolve()
  return state
}
export async function withRpcActionLog(name, work) {
  return action.run(name, async () => {
    record('action_start')
    try { return await work() }
    finally {
      record('action_end'); const state = S(); state.completed.add(name)
      if (earlyActions.every(name => state.completed.has(name))) state.earlyDone.resolve()
    }
  })
}
export const withDatabaseOperation = (_name, read) => read()
export async function headers() { return new Headers() }
export const auth = { api: { async getSession() {
  const state = S(); state.authCalls.push(action.getStore() ?? null); record('authenticate')
  return state.authenticated ? { user: { id: state.owner, email: 'fixture@example.invalid', name: 'Fixture', image: null }, session: { id: 'fixture-session' } } : null
} } }
export async function currentUser() { return (await auth.api.getSession({ headers: await headers() }))?.user ?? null }
export async function requireUser() { const user = await currentUser(); if (!user) throw new ActionFailureError('authRequired'); return user }
export const getLocale = async () => 'en'
export const cookies = async () => ({ get: () => ({ value: S().selected }) })
export const tokenWorkspace = Symbol('fixture-token-workspace')
export function cache(read) { return (...args) => { const state = S(); let entries = state.memo.get(read); if (!entries) state.memo.set(read, entries = new Map()); const key = JSON.stringify(args); if (!entries.has(key)) entries.set(key, read(...args)); return entries.get(key) } }
export const ensurePersonalShare = async () => { record('share_checked') }
export const ensurePersonalWorkspace = async () => { throw new WorkspaceError('workspaceAccessDenied') }
export const renameGeneratedWorkspace = () => null
export const z = { uuid: () => ({ parse: value => value }) }

const expression = new Proxy(function () { return expression }, { get: (_target, key) => key === 'then' ? undefined : expression })
export const sql = expression, and = expression, or = expression, eq = expression, desc = expression, asc = expression, inArray = expression, isNotNull = expression
export const agents = expression, agentRuns = expression, bots = expression, devices = expression, issues = expression, users = expression, issueMembers = expression
export const teamIssues = expression, localTeams = expression, workspaces = expression, workspaceMembers = expression
export const runAgentName = expression, runBotId = expression, runBotName = expression, runTaskPrompt = expression, runFailureBrief = expression
export const issueShortTitle = expression, issueAttrsContent = expression, issueChecklistTotal = expression, issueChecklistChecked = expression
function queryBuilder(kind) {
  let value
  value = new Proxy(function () { return value }, { get: (_target, key) => {
    if (key === 'then') return (resolve, reject) => Promise.resolve().then(async () => {
      const state = S()
      if (kind === 'workspace') {
        record('workspace_context_query_started')
        await state.workspaceGate.promise
        if (state.workspaceError) throw new WorkspaceError('workspaceAccessDenied')
        record('workspace_context_query_completed')
        return [{ id: state.home, name: 'Fixture personal', kind: 'personal', role: 'admin' },
          ...(state.selected !== state.home ? [{ id: state.selected, name: 'Fixture team', kind: 'team', role: 'member' }] : [])]
      }
      record('business_rows_read', { revisionAtData: state.revision })
      return []
    }).then(resolve, reject)
    return value
  } })
  return value
}
export const db = { select: () => queryBuilder('business'), selectDistinctOn: () => queryBuilder('business'), selectDistinct: () => queryBuilder('business') }
export const workspaceDb = { select: () => queryBuilder('workspace') }
export const workspacePool = { async query(sql, values) {
  const state = S(); record('owner_scope_query', { requestedOwner: values[0] })
  if (!sql.includes('mikka_workspaces') || values[0] !== state.owner) throw new Error('unexpected owner authority')
  return { rows: state.homeAvailable ? [{ ownerId: state.owner, workspaceId: state.home }] : [] }
} }
export const pool = { async query(sql, values) {
  const state = S()
  if (!sql.startsWith('SELECT r.kind') || !sql.includes('JOIN unnest')) throw new Error('only original SELECT permitted in fixture')
  const call = { kinds: [...values[0]], ids: [...values[1]], revision: state.revision }
  state.revisionQueries.push(call); record('revision_query', call)
  if (state.failRevisionOnce && !state.revisionFailed) { state.revisionFailed = true; throw Object.assign(new Error('fixture revision unavailable'), { code: '08006' }) }
  const rows = values[0].flatMap((kind, index) => state.missingKinds?.includes(kind) ? [] : [{ kind, id: values[1][index], revision: String(state.revision) }])
  call.rowCount = rows.length
  call.rowJsonBytes = Buffer.byteLength(JSON.stringify(rows))
  record('revision_observed', { kinds: call.kinds, ids: call.ids, revision: state.revision })
  return { rows }
} }
export const singleFlight = (_keys, read) => read()
export async function queryVersion() { record('business_version_read', { revisionAtData: S().revision }); return String(S().revision).padStart(32, '0') }
export async function queryVersionWithExpiry() { return { version: await queryVersion(), expiresAt: null } }
export const gatewayConfig = () => null
export const deviceOnlineStates = async () => new Map()
export const DEVICE_ONLINE_WINDOW_MS = 300_000
export const isDeviceOnline = () => false
export const withDevicePresence = value => value
export const readCompactRunFailure = value => value ?? null
export const replyLine = value => value ?? null
export const accessibleTeamScopes = async () => []
export const issueVisibility = async () => ({ predicate: expression, links: [] })
export const issueTeamScope = async () => []
export const actingContext = { getStore: () => undefined }
export const readIssueMetadata = () => ({})
export const taskIdentifiers = async () => new Map()
export const checklistView = () => ({ total: 0, checked: 0 })
export const chatStore = { async botChatSnapshot() { record('business_summary_read', { revisionAtData: S().revision }); return { items: {}, expiries: [], observedAt: 0 } } }
