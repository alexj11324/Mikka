import { withRequestLog } from '@/lib/request-log'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { writeDueBriefings } from '@/lib/suggestions/store'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Leaves time to answer before maxDuration; whoever is left is written by the next run. */
const BUDGET_MS = 40_000
/** How many Coordinators are woken at once. */
const WAKE_CONCURRENCY = 8

// Called every 15 minutes by the Cloudflare Worker in cloudflare/suggestions-cron.
async function handleGET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  const deadline = Date.now() + BUDGET_MS
  const [briefings, ci] = await Promise.all([
    writeDueBriefings({ deadline }),
    (async () => {
      try {
        const [{ pool }, { reconcileCi }, { retryPendingCiEscalations }] = await Promise.all([import('@/lib/db'), import('@/lib/github/ci/reconcile'), import('@/lib/github/ci/escalation-recovery')])
        const [observations, escalations] = await Promise.all([reconcileCi({ pool, deadline, limit: 4 }), retryPendingCiEscalations({ pool, deadline })])
        return { ...observations, failed: observations.failed + escalations.failed, escalationsRetried: escalations.attempted }
      } catch { return { failed: 1 } }
    })(),
  ])
  const { result, pushed } = briefings
  // Each written briefing waits in the person's Coordinator inbox; waking it has the Coordinator write it to them.
  for (let index = 0; index < pushed.length; index += WAKE_CONCURRENCY) {
    await Promise.all(pushed.slice(index, index + WAKE_CONCURRENCY).map(userId => wakeCoordinator(userId)))
  }
  return Response.json({ ...result, pushed: pushed.length, ci }, { status: ci.failed ? 502 : 200, headers: { 'Cache-Control': 'no-store' } })
}

export const GET = withRequestLog('/api/cron/briefings', handleGET)
