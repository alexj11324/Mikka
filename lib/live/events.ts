export const LIVE_KINDS = ['thread_list', 'task_run_list', 'bot_chat_list', 'device_list', 'bot_chat', 'issue_list', 'bot_list', 'group_list', 'workspace_settings', 'computer_state', 'approved_writes', 'approved_write', 'pending_actions', 'factory_task', 'factory_issue', 'issue_document', 'artifact', 'issue_members', 'issue_relations', 'issue_threads', 'thread', 'run', 'coordinator_session', 'model_settings', 'group_chat', 'hosted_billing', 'pull_request_status', 'subagent_events', 'project_map', 'resource_access'] as const
export type LiveKind = typeof LIVE_KINDS[number]
/** `rev` is a post-commit counter of this key (lib/live/revisions.ts), never content. */
export type LiveInvalidation = { kind: LiveKind; id: string; rev?: number }
export const LIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const LIVE_CHANNEL = /^[a-f0-9]{64}$/
/** Kinds whose pushes carry a revision. A reader of one returns the same counter. */
export const LIVE_REVISION_KINDS = ['bot_chat', 'bot_chat_list', 'issue_list', 'thread', 'run', 'task_run_list', 'group_chat', 'thread_list', 'project_map'] as const satisfies readonly LiveKind[]
export type LiveRevisionKind = typeof LIVE_REVISION_KINDS[number]
export const isLiveRevisionKind = (kind: LiveKind): kind is LiveRevisionKind => (LIVE_REVISION_KINDS as readonly LiveKind[]).includes(kind)
/** Version 2 sockets ask with this query parameter; version 1 sockets get only `{kind, id}`. */
export const LIVE_REVISION_PARAM = 'revisions'
export const liveRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** The wire format is an invalidation key, never business content. A version 2
 * key may add its revision; a version 1 client keeps rejecting a third field. */
export function liveInvalidation(value: unknown, revisions = false): LiveInvalidation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const size = Object.keys(record).length
  if (typeof record.id !== 'string' || !LIVE_ID.test(record.id)) return null
  if (!LIVE_KINDS.includes(record.kind as LiveKind)) return null
  if (size === 2) return { kind: record.kind as LiveKind, id: record.id }
  if (!revisions || size !== 3 || !liveRevision(record.rev) || !isLiveRevisionKind(record.kind as LiveKind)) return null
  return { kind: record.kind as LiveKind, id: record.id, rev: record.rev }
}

export function liveInvalidations(value: unknown, revisions = false): LiveInvalidation[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null
  const events = value.map(event => liveInvalidation(event, revisions))
  return events.every((event): event is LiveInvalidation => event !== null) ? events : null
}

/** What a version 1 socket (or an older Worker) carries: the same keys, no revision. */
export const withoutRevisions = (events: readonly LiveInvalidation[]): LiveInvalidation[] => events.map(({ kind, id }) => ({ kind, id }))

/** Readiness describes this deployed Worker, not WebSocket liveness or action
 * authority. Unknown future names are ignored by older clients. Version 1 is
 * exactly what older clients accept; only a socket that asked gets version 2. */
export function liveReady(version: 1 | 2 = 1) {
  return version === 2
    ? { type: 'live_ready', version: 2, kinds: [...LIVE_KINDS], revisions: [...LIVE_REVISION_KINDS] }
    : { type: 'live_ready', version: 1, kinds: [...LIVE_KINDS] }
}

const kindNames = (value: unknown) => Array.isArray(value) && value.length <= 32
  && value.every(kind => typeof kind === 'string' && /^[a-z_]{1,64}$/.test(kind)) && new Set(value).size === value.length

/** The Worker's kinds, and the kinds whose keys carry a revision (none for version 1). */
export function liveReadiness(value: unknown): { kinds: LiveKind[]; revisions: LiveKind[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const size = Object.keys(record).length
  if (record.type !== 'live_ready' || !kindNames(record.kinds)) return null
  if (!(record.version === 1 && size === 3) && !(record.version === 2 && size === 4 && kindNames(record.revisions))) return null
  const known = (names: unknown) => (names as string[]).filter((kind): kind is LiveKind => LIVE_KINDS.includes(kind as LiveKind))
  return { kinds: known(record.kinds), revisions: record.version === 2 ? known(record.revisions).filter(isLiveRevisionKind) : [] }
}

export function liveCapabilities(value: unknown): LiveKind[] | null {
  return liveReadiness(value)?.kinds ?? null
}
