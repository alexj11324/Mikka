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

/** Starts the successor on the latest deployment: from a step, start() would otherwise pin it to this run's (#1410). */
export async function handOffDueTimer(kind: DueKind) {
  'use step'
  const { start } = await import('workflow/api')
  const { dueTimer } = await import('./workflow')
  await start(dueTimer, [kind], { deploymentId: 'latest' })
}

/** The deployment this run executes on; a step, so the workflow reads it once and replays it. */
export async function dueTimerDeployment() {
  'use step'
  return process.env.VERCEL_DEPLOYMENT_ID ?? null
}
