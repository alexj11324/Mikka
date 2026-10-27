import { withRequestLog } from '@/lib/request-log'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { writeDueBriefings } from '@/lib/suggestions/store'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Leaves time to answer before maxDuration; whoever is left is written by the next run. */
const BUDGET_MS = 45_000

// Called every 15 minutes by the Cloudflare Worker in cloudflare/suggestions-cron.
async function handleGET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  return Response.json(await writeDueBriefings({ deadline: Date.now() + BUDGET_MS }), { headers: { 'Cache-Control': 'no-store' } })
}

export const GET = withRequestLog('/api/cron/briefings', handleGET)
