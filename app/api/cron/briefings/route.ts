import { withRequestLog } from '@/lib/request-log'
import { cronJob } from '@/lib/background'
import { cronUnauthorized } from '@/lib/cron-auth'
import { writeDueBriefings } from '@/lib/suggestions/store'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Leaves time to answer before maxDuration; whoever is left is written by the next run. */
const BUDGET_MS = 40_000

// Called every 15 minutes by the Cloudflare Worker in cloudflare/suggestions-cron.
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  const result = await writeDueBriefings({ deadline: Date.now() + BUDGET_MS })
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
}

export const GET = withRequestLog('/api/cron/briefings', cronJob('briefings', handleGET))
