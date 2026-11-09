// Temporary, opt-in acceptance diagnostics. No authorization, network, timers or proof mutation.
type Ref = object | undefined
export type ReadDiagnosticFields = {
  cache?: Ref; read?: Ref; channel?: Ref; request?: Ref; item?: Ref; key?: string; scope?: string | null; entity?: string
  after?: number; began?: number; pending?: number; sent?: number; generation?: number; count?: number; status?: number; revision?: number
  accepted?: boolean; received?: boolean; superseded?: boolean; unconditional?: boolean; reuse?: boolean; proof?: boolean
  event?: string; reason?: string; state?: string; outcome?: string; kind?: string; action?: string; actions?: readonly string[]
}
const actions = new Set(['desktop.readBatch', 'desktop.bootstrap', 'desktop.session', 'workspace.switchWorkspace',
  'coordinator.syncCoordinatorChat', 'coordinator.pollBotChatSummaries', 'execution-settings.getBotModelMenu',
  'issues.syncIssueList', 'task-runs.syncThreadList', 'task-runs.pollTaskRuns', 'bots.pollBots',
  'teams.listTeams', 'team-relations.listProjectTeams', 'projects.listProjects'])
const labels = new Set(['live_observe', 'live_invalidate', 'live_flush', 'live_refresh', 'live_subscribe', 'live_unsubscribe',
  'read_entry', 'read_received', 'read_complete', 'read_fresh', 'pending_capture', 'pending_dispatch', 'pending_revoke',
  'rpc_dispatch', 'rpc_headers', 'rpc_decoded', 'rpc_failed', 'batch_enqueue', 'batch_send', 'batch_fallback',
  'socket', 'received', 'skipped', 'read', 'connecting', 'open', 'ready', 'closed',
  'hidden', 'revision_held', 'unsubscribed', 'covered', 'invalid', 'late_subscribe', 'visibility', 'deadline',
  'fallback', 'socket_open', 'push', 'capabilities', 'presence', 'other',
  'no_read', 'before_boundary', 'wait_settled', 'wait_pending', 'retired', 'revoked', 'failed',
  'committed', 'discarded', 'covers', 'revision_uncovered', 'not_returned', 'newer_read', 'revalidate'])
const kinds = new Set(["thread_list","task_run_list","bot_chat_list","device_list","bot_chat","issue_list","bot_list","group_list","workspace_settings","computer_state","approved_writes","approved_write","pending_actions","factory_task","factory_issue","issue_document","artifact","issue_members","issue_relations","issue_threads","thread","run","coordinator_session","model_settings","group_chat","hosted_billing","pull_request_status","subagent_events","project_map"])
const families = new Set(['coordinator-chat', 'coordinator-chat-metadata', 'bot-chats', 'threads', 'task-runs',
  'issues', 'bots', 'teams', 'project-teams', 'bot-list-groups', 'approved-writes', 'pending-actions'])
const refs = new WeakMap<object, number>()
const keys = new Map<string, number>()
const scopes = new Map<string, number>()
const entities = new Map<string, number>()
let nextRef = 0, nextKey = 0, nextScope = 0, nextEntity = 0, producer: string | undefined
const reference = (value: object) => {
  let id = refs.get(value)
  if (id === undefined) { if (nextRef >= 4096) return 0; id = ++nextRef; refs.set(value, id) }
  return id
}
const intern = (values: Map<string, number>, value: string, next: () => number) => {
  let id = values.get(value)
  if (id === undefined) {
    if (values.size >= 256) return 0
    id = next(); values.set(value, id)
  }
  return id
}
const noteFailure = () => {
  try {
    const state = Object.getOwnPropertyDescriptor(globalThis, '__mikkaReadDiagnosticState')?.value
    if (state && Number.isSafeInteger(state.failures)) state.failures++
  } catch { /* only diagnostic completeness is affected */ }
}
/** Objects and raw cache keys stay inside this module. Only bounded scalar metadata reaches the test sink. */
export function observeReadDiagnostic(event: string, fields: ReadDiagnosticFields = {}): void {
  try {
    const sink = Object.getOwnPropertyDescriptor(globalThis, '__mikkaReadDiagnostic')?.value
    if (typeof sink !== 'function') return
    producer ??= crypto.randomUUID()
    const row: Record<string, string | number | boolean | string[]> = {
      version: 1, producer, event: labels.has(event) ? event : 'other', monotonicMs: performance.now(), wallMs: Date.now(),
    }
    let omittedReferences = 0
    for (const name of ['cache', 'read', 'channel', 'request', 'item'] as const) {
      const value = fields[name]
      if (value !== undefined && value !== null && (typeof value === 'object' || typeof value === 'function')) {
        const id = reference(value); row[name + 'Id'] = id; if (id === 0) omittedReferences++
      }
    }
    if (typeof fields.key === 'string') {
      row.keyId = intern(keys, fields.key, () => ++nextKey)
      row.keyOmitted = row.keyId === 0
      const family = /^@?"?([a-z][a-z0-9:_-]{0,63})(?:"|,|$)/.exec(fields.key)?.[1]
      row.keyFamily = family && families.has(family) ? family : 'other'
    }
    if (typeof fields.scope === 'string') {
      row.scopeId = intern(scopes, fields.scope, () => ++nextScope); row.scopeOmitted = row.scopeId === 0; row.scopeKnown = true
    } else if (fields.scope === null) row.scopeKnown = false
    if (typeof fields.entity === 'string') {
      row.entityId = intern(entities, fields.entity, () => ++nextEntity); row.entityOmitted = row.entityId === 0
    }
    row.omittedReferences = omittedReferences
    for (const name of ['after', 'began', 'pending', 'sent', 'generation', 'count', 'status', 'revision'] as const) {
      const value = fields[name]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) row[name] = value
    }
    for (const name of ['accepted', 'received', 'superseded', 'unconditional', 'reuse', 'proof'] as const) {
      if (typeof fields[name] === 'boolean') row[name] = fields[name]
    }
    for (const name of ['event', 'reason', 'state', 'outcome'] as const) {
      const value = fields[name]
      if (typeof value === 'string') row[name === 'event' ? 'observedEvent' : name] = labels.has(value) ? value : 'other'
    }
    if (typeof fields.kind === 'string') row.kind = kinds.has(fields.kind) ? fields.kind : 'other'
    if (typeof fields.action === 'string') row.action = actions.has(fields.action) ? fields.action : 'other'
    if (fields.actions) {
      row.actions = fields.actions.slice(0, 16).map(action => actions.has(action) ? action : 'other')
      row.omittedActions = Math.max(0, fields.actions.length - 16)
    }
    // The sink handles its own asynchronous delivery failures; the product never waits for it.
    const delivered: unknown = sink(row)
    if (delivered !== undefined) void Promise.resolve(delivered).catch(noteFailure)
  } catch { noteFailure() }
}

export const READ_DIAGNOSTIC_SCHEMA = Object.freeze({ version: 1, events: Object.freeze([...labels]), actions: Object.freeze([...actions]), families: Object.freeze([...families]), kinds: Object.freeze([...kinds]) })
