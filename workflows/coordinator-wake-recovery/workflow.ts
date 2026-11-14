import type { WakeDeadlineTicket } from '@/lib/coordinator/wake-recovery'
import { wakeTokens } from '@/lib/workflow-wake-tokens'
import { workflowWakes } from '../wake'
import { recoverWakeDeadlineStep } from './steps'

/**
 * Resume a deadline already scheduled by the pre-Eve Coordinator. Keep the
 * persisted Workflow and step names while those runs drain. The recovery step
 * now wakes the ordinary product outbox and completes the old Workflow.
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
