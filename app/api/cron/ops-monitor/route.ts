import { verifyBearer } from '@/lib/linear-sync/webhook'
import { withRequestLog } from '@/lib/request-log'
import { pool } from '@/lib/db'
import { collectOperationalSignals } from '@/lib/ops/monitor'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }
async function handleGET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503, headers })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401, headers })
  try {
    const result = await collectOperationalSignals(pool, { sink: process.env.OPS_INTERNAL_ALERT_SINK })
    return Response.json(result, { status: result.databaseAvailable && result.notificationStatus !== 'failed' ? 200 : 503, headers })
  } catch { return Response.json({ error: 'opsMonitorUnavailable', persisted: false }, { status: 503, headers }) }
}
export const GET = withRequestLog('/api/cron/ops-monitor', handleGET)
