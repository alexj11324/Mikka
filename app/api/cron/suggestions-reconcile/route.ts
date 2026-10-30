import { withRequestLog } from '@/lib/request-log'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { reconcileSuggestions } from '@/lib/suggestions/reconcile'
import { runFactoryMonitorCron } from '@/lib/factory/monitor-cron'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Leaves time to answer before maxDuration; whoever is left is read by the next run. */
const BUDGET_MS = 40_000
/** The Factory monitor sweep runs after the backfill and stops starting new scopes here. */
const FACTORY_MONITOR_BUDGET_MS = 50_000

// Called hourly by the Cloudflare Worker in cloudflare/suggestions-cron.
//
// Documented exception to "GET is strictly read-only": this is a cron endpoint (the Vercel Cron
// pattern, which only issues GET). It writes, so it accepts nothing but the exact CRON_SECRET
// bearer (503 when unset, 401 otherwise, before any read or write), and every write it makes is
// idempotent, so a repeated or overlapping run converges on the same state. See docs/suggestions-cron.md.
async function handleGET(request: Request) {
  const started = Date.now()
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  const result = await reconcileSuggestions({ deadline: started + BUDGET_MS })
  const factoryMonitor = await runFactoryMonitorCron({ deadline: started + FACTORY_MONITOR_BUDGET_MS }).catch(() => {
    console.error('factory monitor sweep failed')
    return { enabled: true, scopes: 0, observed: 0, failed: 1, deferred: 0 }
  })
  return Response.json({ ...result, factoryMonitor }, {
    status: Object.values(result.failed).some(Boolean) || result.github?.errors || factoryMonitor.failed ? 502 : !result.github?.configured ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export const GET = withRequestLog('/api/cron/suggestions-reconcile', handleGET)
