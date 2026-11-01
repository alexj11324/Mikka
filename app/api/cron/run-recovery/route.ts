import { verifyBearer } from '@/lib/linear-sync/webhook'
import { sweepExpiredRunLeases } from '@/lib/run-leases'
import { reconcileCloudMachines } from '@/lib/computer/reconcile'
import { pool } from '@/lib/db'
import { judgePendingOutcomes } from '@/lib/run-outcome-judge'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }

/** The existing cron Worker calls this independently of owner/device requests. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503, headers })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401, headers })
  try {
    const runs = await sweepExpiredRunLeases()
    // Bot computers whose sandbox E2B no longer has stop claiming to run.
    const machines = await reconcileCloudMachines(pool).catch(() => null)
    // Ended runs never judged (any end path, and the last week before outcomes existed) get their outcome (R-52).
    const outcomes = await judgePendingOutcomes().catch(() => null)
    return Response.json({ ...runs, machines, outcomes }, { headers })
  }
  catch { return Response.json({ error: 'runRecoverySweepFailed' }, { status: 502, headers }) }
}
