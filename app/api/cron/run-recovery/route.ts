import { cronUnauthorized } from '@/lib/cron-auth'
import { sweepExpiredRunLeases } from '@/lib/run-leases'
import { reconcileCloudMachines } from '@/lib/computer/reconcile'
import { pool } from '@/lib/db'
import { judgePendingOutcomes } from '@/lib/run-outcome-judge'
import { endClosedTaskMachines } from '@/lib/cloud-computer/thread-machines'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }

/** The existing cron Worker calls this independently of owner/device requests. */
export async function GET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try {
    const runs = await sweepExpiredRunLeases()
    // Bot computers whose sandbox E2B no longer has stop claiming to run.
    const machines = await reconcileCloudMachines(pool).catch(() => null)
    // Ended runs never judged (any end path, and the last week before outcomes existed) get their outcome (R-52).
    const outcomes = await judgePendingOutcomes().catch(() => null)
    // Paused task sandboxes whose task closed are killed (one task, one sandbox).
    const taskMachines = await endClosedTaskMachines(pool).catch(() => null)
    return Response.json({ ...runs, machines, outcomes, taskMachines }, { headers })
  }
  catch { return Response.json({ error: 'runRecoverySweepFailed' }, { status: 502, headers }) }
}
