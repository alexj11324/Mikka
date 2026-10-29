import type { ApprovalActionName } from '@/lib/composio-actions'
import type { PendingActionStatus } from '@/lib/db/schema'

/** One pending action as the approval card shows it. */
export interface PendingActionView {
  id: string
  action: ApprovalActionName | 'approve_repository_push' | 'browser_operation' | 'credential_operation'
  input: Record<string, unknown>
  /** For a calendar change: the event as it is now. */
  context: { summary?: string; start?: string; end?: string } | null
  status: PendingActionStatus
  createdAt: string
}

/** How long a proposal waits for the person before it no longer shows. */
export const PENDING_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function eventTime(value: unknown): string | undefined {
  const time = record(value)
  const text = time?.dateTime ?? time?.date
  return typeof text === 'string' ? text : undefined
}

/** The fields of a Google Calendar event the card shows; Composio nests it under `response_data` for some tools. */
export function calendarEventSummary(data: Record<string, unknown> | null | undefined): PendingActionView['context'] {
  const event = record(data?.response_data) ?? data
  if (!event) return null
  const summary = typeof event.summary === 'string' ? event.summary : undefined
  const start = eventTime(event.start)
  const end = eventTime(event.end)
  return summary || start || end ? { summary, start, end } : null
}

/** What to keep from a successful run: ids and the link, not the whole response. */
export function actionOutcome(data: Record<string, unknown> | null | undefined): Record<string, string> {
  const outcome: Record<string, string> = {}
  for (const source of [data, record(data?.response_data)]) {
    for (const key of ['id', 'threadId', 'htmlLink'] as const) {
      const value = source?.[key]
      if (typeof value === 'string' && !outcome[key]) outcome[key] = value
    }
  }
  return outcome
}
