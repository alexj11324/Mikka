import { withRequestLog } from '@/lib/request-log'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { processLinearSyncBatch } from '@/lib/linear-sync/worker'

export const runtime = 'nodejs'
export const maxDuration = 60

async function handleGET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  return Response.json(await processLinearSyncBatch())
}

export const GET = withRequestLog('/api/cron/linear-sync', handleGET)
