import { withRequestLog } from '@/lib/request-log'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { profileEnabled } from '@/lib/profile/flags'
import { consolidateDueFacts } from '@/lib/profile/store'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Leaves time to answer before maxDuration; whoever is left is merged by the next run. */
const BUDGET_MS = 40_000

// Called hourly at :30 by the Cloudflare Worker in cloudflare/suggestions-cron;
// each person is merged once a local day, from 04:00 their time (R-73).
async function handleGET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  // PROACTIVE_PROFILE_ENABLED off: nothing to merge, and the Worker's run still succeeds.
  if (!profileEnabled()) return Response.json({ skipped: 'disabled' }, { headers: { 'Cache-Control': 'no-store' } })
  const result = await consolidateDueFacts({ deadline: Date.now() + BUDGET_MS })
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
}

export const GET = withRequestLog('/api/cron/user-facts', handleGET)
