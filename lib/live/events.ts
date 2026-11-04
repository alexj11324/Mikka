export const LIVE_KINDS = ['factory_task', 'factory_issue', 'issue_document', 'thread', 'run'] as const
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
