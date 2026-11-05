import { sleep } from 'workflow'
import type { WakeDeadlineTicket } from '@/lib/coordinator/wake-recovery'
import { recoverWakeDeadlineStep } from './steps'

/** Only the original pending batch lives here; there is no idle per-Bot pump. */
export async function coordinatorWakeDeadline(ticket: WakeDeadlineTicket) {
  'use workflow'
  let next: { ticket: WakeDeadlineTicket; at: string } | null = { ticket, at: ticket.at }
  while (next) {
    await sleep(new Date(next.at))
    next = await recoverWakeDeadlineStep(next.ticket)
  }
}
