import { withRequestLog } from '@/lib/request-log'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { reconcileSuggestions } from '@/lib/suggestions/reconcile'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Leaves time to answer before maxDuration; whoever is left is read by the next run. */
const BUDGET_MS = 40_000

// Called hourly by the Cloudflare Worker in cloudflare/suggestions-cron.
async function handleGET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  return Response.json(await reconcileSuggestions({ deadline: Date.now() + BUDGET_MS }), { headers: { 'Cache-Control': 'no-store' } })
}

export const GET = withRequestLog('/api/cron/suggestions-reconcile', handleGET)
