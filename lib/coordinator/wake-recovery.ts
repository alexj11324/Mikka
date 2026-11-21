/** Threshold for interpreting persisted attempts from before the Eve migration. */
export const MAX_WAKE_ATTEMPTS = 8

/**
 * A coordinator event the 15-minute safety net may still start: not delivered,
 * not background, wakes not exhausted, due and not leased. The reconcile check
 * (lib/reconcile-due.ts) and the sweep it starts (retryCoordinatorWakes) read
 * this same predicate, so the sweep only visits chats the check counted. An
 * event whose wakes ran out stays in its chat's inbox for that chat's next
 * event-driven wake; the sweep no longer re-checks it every 15 minutes.
 */
export const COORDINATOR_WAKE_DUE_SQL = `"deliveredAt" IS NULL AND "wakeAttempts" < ${MAX_WAKE_ATTEMPTS}
  AND (tier IS NULL OR tier <> 'background') AND "nextWakeAt" <= now() AND ("wakeLeaseUntil" IS NULL OR "wakeLeaseUntil" <= now())`

/** The chats retryCoordinatorWakes visits: those with a due wake (above). */
export const COORDINATOR_WAKE_SCOPES_SQL = `SELECT DISTINCT "userId","botId" FROM coordinator_events WHERE "botId" IS NOT NULL AND ${COORDINATOR_WAKE_DUE_SQL}`

/** Stored input of a previously queued Coordinator deadline Workflow. */
export type WakeDeadlineTicket = {
  userId: string
  botId: string
  at: string
  events: { id: string; attempt: number; nextWakeAt: string; leaseUntil: string | null }[]
}
