import { cronUnauthorized } from '@/lib/cron-auth'
import { afterJob, cronJob } from '@/lib/background'
import { pool } from '@/lib/db'
import { reconcileDue } from '@/lib/reconcile-due'
import { armDueTimer } from '@/lib/due-timer'

export const runtime = 'nodejs'
// Run recovery's group-turn sweep keeps generating after the answer, as the run-recovery route does.
export const maxDuration = 300
const headers = { 'cache-control': 'no-store' }

/**
 * The single safety-net sweep (#1371), called every 15 minutes by the minute
 * Worker. Coordinator wakes, schedules and run recovery start from their writes
 * and their durable timers; this recovers only work already due that none of
 * them picked up (a start lost between COMMIT and its wake, a timer that
 * failed). Worst case, such work runs 15 minutes after its due time. An idle
 * call costs one statement.
 */
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try {
    const { factoryLifecycleEnabled } = await import('@/lib/factory/runtime')
    const due = await reconcileDue(pool, { factoryLifecycle: factoryLifecycleEnabled() })
    const counts: Record<string, unknown> = { ...due }
    if (due.wakes) counts.wakeCounts = await (await import('@/lib/coordinator/wake')).retryCoordinatorWakes()
    if (due.schedules) {
      counts.scheduleCounts = await (await import('@/lib/schedules/runtime')).sweepSchedules()
      await armDueTimer('schedules')
    }
    if (due.recovery) {
      counts.recoveryCounts = await (await import('@/lib/run-recovery')).recoverRuns(work => afterJob('cron:reconcile/group-turns', work))
      await armDueTimer('run-recovery')
    }
    return Response.json(counts, { headers })
  }
  catch { return Response.json({ error: 'reconcileFailed' }, { status: 502, headers }) }
}

export const GET = cronJob('reconcile', handleGET)
