import { cronUnauthorized } from '@/lib/cron-auth'
import { cronJob } from '@/lib/background'
import { withRequestLog } from '@/lib/request-log'
import { pool } from '@/lib/db'
import { collectOperationalSignals } from '@/lib/ops/monitor'
import { collectProviderEgress } from '@/lib/ops/egress-fallback'
import { isCloudEdition } from '@/lib/edition'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try {
    const cloud = isCloudEdition()
    const [operational, provider] = await Promise.allSettled([
      collectOperationalSignals(pool, { sink: process.env.OPS_INTERNAL_ALERT_SINK }),
      cloud ? collectProviderEgress(pool, { neonToken: process.env.NEON_API_KEY, posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY })
        : Promise.resolve({ status: 'not_applicable' as const }),
    ])
    if (operational.status !== 'fulfilled' || provider.status !== 'fulfilled') throw Error('opsMonitorUnavailable')
    const result = operational.value, egress = provider.value
    return Response.json({ ...result, egress }, { status: result.databaseAvailable && result.notificationStatus !== 'failed' && egress.status !== 'failed' ? 200 : 503, headers })
  } catch { return Response.json({ error: 'opsMonitorUnavailable', persisted: false }, { status: 503, headers }) }
}
export const GET = withRequestLog('/api/cron/ops-monitor', cronJob('ops-monitor', handleGET))
