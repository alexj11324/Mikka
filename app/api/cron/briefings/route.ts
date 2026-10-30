import { withRequestLog } from '@/lib/request-log'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { writeDueBriefings } from '@/lib/suggestions/store'
import { ciResumeEnabled } from '@/lib/github/ci/flag'

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
  // Isolated sub-task (off unless MIKKA_CI_RESUME_ENABLED=1): runs alongside the
  // briefings, never throws, and never changes this cron's status.
  const ciTask = ciResumeEnabled() ? import('@/lib/github/ci/cron').then(({ runCiReconcileCron }) => runCiReconcileCron({ deadline })).catch(() => ({ status: 'failed' as const })) : null
  let briefings: Awaited<ReturnType<typeof writeDueBriefings>>
  try { briefings = await writeDueBriefings({ deadline }) }
  catch (error) { await ciTask; throw error }
  const { result, pushed } = briefings
  // Each written briefing waits in the person's Coordinator inbox; waking it has the Coordinator write it to them.
  for (let index = 0; index < pushed.length; index += WAKE_CONCURRENCY) {
    await Promise.all(pushed.slice(index, index + WAKE_CONCURRENCY).map(userId => wakeCoordinator(userId)))
  }
  const ci = ciTask ? await ciTask : null
  return Response.json({ ...result, pushed: pushed.length, ...(ci ? { ci } : {}) }, { headers: { 'Cache-Control': 'no-store' } })
}

export const GET = withRequestLog('/api/cron/briefings', handleGET)
