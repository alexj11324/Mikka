export const LIVE_KINDS = ['thread_list', 'task_run_list', 'bot_chat_list', 'device_list', 'bot_chat', 'issue_list', 'bot_list', 'group_list', 'workspace_settings', 'computer_state', 'approved_writes', 'approved_write', 'pending_actions', 'factory_task', 'factory_issue', 'issue_document', 'artifact', 'issue_members', 'issue_relations', 'issue_threads', 'thread', 'run', 'coordinator_session', 'model_settings', 'group_chat', 'pull_request_status'] as const
export type LiveKind = typeof LIVE_KINDS[number]
export type LiveInvalidation = { kind: LiveKind; id: string }
export const LIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const LIVE_CHANNEL = /^[a-f0-9]{64}$/

/** The wire format is an invalidation key, never business content. */
export function liveInvalidation(value: unknown): LiveInvalidation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || typeof record.id !== 'string' || !LIVE_ID.test(record.id)) return null
  if (!LIVE_KINDS.includes(record.kind as LiveKind)) return null
  return { kind: record.kind as LiveKind, id: record.id }
}

export function liveInvalidations(value: unknown): LiveInvalidation[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null
  const events = value.map(liveInvalidation)
  return events.every((event): event is LiveInvalidation => event !== null) ? events : null
}

/** Readiness describes this deployed Worker, not WebSocket liveness or action
 * authority. Unknown future names are ignored by older clients. */
export function liveReady() {
  return { type: 'live_ready', version: 1, kinds: [...LIVE_KINDS] }
}

export function liveCapabilities(value: unknown): LiveKind[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3 || record.type !== 'live_ready' || record.version !== 1
    || !Array.isArray(record.kinds) || record.kinds.length > 32
    || !record.kinds.every(kind => typeof kind === 'string' && /^[a-z_]{1,64}$/.test(kind))
    || new Set(record.kinds).size !== record.kinds.length) return null
  return record.kinds.filter((kind): kind is LiveKind => LIVE_KINDS.includes(kind as LiveKind))
}
