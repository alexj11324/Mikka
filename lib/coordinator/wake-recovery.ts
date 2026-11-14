/** Threshold for interpreting persisted attempts from before the Eve migration. */
export const MAX_WAKE_ATTEMPTS = 8

/** Stored input of a previously queued Coordinator deadline Workflow. */
export type WakeDeadlineTicket = {
  userId: string
  botId: string
  at: string
  events: { id: string; attempt: number; nextWakeAt: string; leaseUntil: string | null }[]
}
