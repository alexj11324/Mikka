import { RetryableError } from 'workflow'
import type { WakeDeadlineTicket } from '@/lib/coordinator/wake-recovery'

export async function recoverWakeDeadlineStep(ticket: WakeDeadlineTicket) {
  'use step'
  try {
    const { recoverWakeDeadline } = await import('@/lib/coordinator/wake')
    return await recoverWakeDeadline(ticket)
  } catch {
    // error-cause: the Workflow event log would persist raw database/transport text.
    throw new RetryableError('coordinator_wake_deadline_unavailable', { retryAfter: '1m' })
  }
}
recoverWakeDeadlineStep.maxRetries = 3
