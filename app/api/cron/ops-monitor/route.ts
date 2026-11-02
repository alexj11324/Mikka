import { cronUnauthorized } from '@/lib/cron-auth'
import { withRequestLog } from '@/lib/request-log'
import { pool } from '@/lib/db'
import { collectOperationalSignals } from '@/lib/ops/monitor'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try {
    const result = await collectOperationalSignals(pool, { sink: process.env.OPS_INTERNAL_ALERT_SINK })
    return Response.json(result, { status: result.databaseAvailable && result.notificationStatus !== 'failed' ? 200 : 503, headers })
  } catch { return Response.json({ error: 'opsMonitorUnavailable', persisted: false }, { status: 503, headers }) }
}
export const GET = withRequestLog('/api/cron/ops-monitor', handleGET)
