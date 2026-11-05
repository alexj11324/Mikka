import type { WakeDeadlineTicket } from '@/lib/coordinator/wake-recovery'
import { wakeTokens } from '@/lib/workflow-wake-tokens'
import { workflowWakes } from '../wake'
import { recoverWakeDeadlineStep } from './steps'

/**
 * Only the original pending batch lives here; there is no idle per-Bot pump.
 * Each pass waits for the batch's persisted deadline (lease, backoff, or a
 * lease it waits behind), or for a writer releasing that lease to wake it
 * early (#1212). A pass rechecks exact row versions, so an early or duplicate
 * wake cannot claim anything before it is due.
 */
export async function coordinatorWakeDeadline(ticket: WakeDeadlineTicket) {
  'use workflow'
  const until = workflowWakes(wakeTokens.coordinatorWake(ticket.userId, ticket.botId))
  let next: { ticket: WakeDeadlineTicket; at: string } | null = { ticket, at: ticket.at }
  while (next) {
    await until(Date.parse(next.at))
    next = await recoverWakeDeadlineStep(next.ticket)
  }
}
