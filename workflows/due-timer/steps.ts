import { RetryableError } from 'workflow'
import type { DueKind } from '@/lib/due-timer'

export async function runDue(kind: DueKind) {
  'use step'
  try {
    const { dueJobs } = await import('@/lib/due-timer')
    return await dueJobs[kind].run()
  } catch {
    // error-cause: the Workflow event log would persist raw database text; each job's sweep is idempotent.
    throw new RetryableError('due_timer_unavailable', { retryAfter: '1m' })
  }
}
runDue.maxRetries = 5

export async function nextDue(kind: DueKind) {
  'use step'
  const { dueJobs } = await import('@/lib/due-timer')
  return dueJobs[kind].next()
}

export async function handOffDueTimer(kind: DueKind) {
  'use step'
  const { start } = await import('workflow/api')
  const { dueTimer } = await import('./workflow')
  await start(dueTimer, [kind])
}
