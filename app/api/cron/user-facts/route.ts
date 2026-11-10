import { withRequestLog } from '@/lib/request-log'
import { cronJob } from '@/lib/background'
import { cronUnauthorized } from '@/lib/cron-auth'
import { profileEnabled } from '@/lib/profile/flags'
import { profileEntitled } from '@/lib/profile/entitlement'
import { consolidateDueFacts } from '@/lib/profile/store'
import { purgeExpiredMemoryUndo } from '@/lib/profile/memory'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Leaves time to answer before maxDuration; whoever is left is merged by the next run. */
const BUDGET_MS = 40_000

// Called hourly at :30 by the Cloudflare Worker in cloudflare/suggestions-cron;
// each person is merged once a local day, from 04:00 their time (R-73).
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  // PROACTIVE_PROFILE_ENABLED off: nothing to merge, and the Worker's run still succeeds.
  const expiredUndoPurged = await purgeExpiredMemoryUndo()
  if (!profileEnabled()) return Response.json({ skipped: 'disabled', expiredUndoPurged }, { headers: { 'Cache-Control': 'no-store' } })
  const result = await consolidateDueFacts({ entitled: profileEntitled, deadline: Date.now() + BUDGET_MS })
  return Response.json({ ...result, expiredUndoPurged }, { headers: { 'Cache-Control': 'no-store' } })
}

export const GET = withRequestLog('/api/cron/user-facts', cronJob('user-facts', handleGET))
