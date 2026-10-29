import { telegramReplyTargets, type TelegramReplyTarget } from '../coordinator-events'

export interface PendingTelegramTarget extends TelegramReplyTarget {
  /** Exact human source events covered by this reply; later arrivals are separate. */
  sourceEventIds: string[]
}
export interface TelegramPendingEvent {
  id: string
  kind: string
  payload: Record<string, unknown>
}

export function telegramReplyPending(event: TelegramPendingEvent): boolean {
  const value = event.payload.mikkaTelegramReply
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).version === 1
    && (value as Record<string, unknown>).state === 'pending')
}

/** Only newly consumed, host-created human events are enrolled. Old delivered
 * messages without a receipt are never replayed retroactively. */
export function markTelegramPending(event: TelegramPendingEvent): Record<string, unknown> | null {
  if (!telegramReplyTargets([event as Parameters<typeof telegramReplyTargets>[0][number]]).length) return null
  return { ...event.payload, mikkaTelegramReply: { version: 1, state: 'pending' } }
}

export function pendingTelegramTargets(events: readonly TelegramPendingEvent[]): PendingTelegramTarget[] {
  const targets = new Map<string, PendingTelegramTarget>()
  for (const event of events) {
    if (!telegramReplyPending(event)) continue
    for (const source of telegramReplyTargets([event as Parameters<typeof telegramReplyTargets>[0][number]])) {
      const key = JSON.stringify(source)
      const current = targets.get(key) ?? { ...source, sourceEventIds: [] }
      if (!current.sourceEventIds.includes(event.id)) current.sourceEventIds.push(event.id)
      targets.set(key, current)
    }
  }
  return [...targets.values()]
}
