import { withRequestLog } from '@/lib/request-log'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { reconcileSuggestions } from '@/lib/suggestions/reconcile'
import { runFactoryMonitorCron } from '@/lib/factory/monitor-cron'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Leaves time to answer before maxDuration; whoever is left is read by the next run. */
const BUDGET_MS = 40_000
/** The Factory monitor sweep runs alongside the backfill (independently) and stops starting new scopes here. */
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
  // Independent: a throw in one never stops or hides the other. Each failure is logged by name
  // only (no error message, which could carry a secret) and the status is non-2xx.
  const [suggestions, sweep] = await Promise.allSettled([
    reconcileSuggestions({ deadline: started + BUDGET_MS }),
    runFactoryMonitorCron({ deadline: started + FACTORY_MONITOR_BUDGET_MS }),
  ])
  if (suggestions.status === 'rejected') console.error('suggestions reconcile failed')
  if (sweep.status === 'rejected') console.error('factory monitor sweep failed')
  const result = suggestions.status === 'fulfilled' ? suggestions.value : null
  const factoryMonitor = sweep.status === 'fulfilled'
    ? sweep.value
    : { enabled: true, scopes: 0, observed: 0, failed: 1, deferred: 0 }
  const outcome = { suggestions: suggestions.status === 'fulfilled' ? 'ok' : 'failed', factoryMonitor: sweep.status === 'fulfilled' ? 'ok' : 'failed' }
  const failed = !result || Object.values(result.failed).some(Boolean) || result.github?.errors || factoryMonitor.failed
  return Response.json({ ...result, factoryMonitor, outcome }, {
    status: failed ? 502 : !result.github?.configured ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export const GET = withRequestLog('/api/cron/suggestions-reconcile', handleGET)
