import { withRequestLog } from '@/lib/request-log'
import { cronUnauthorized } from '@/lib/cron-auth'
import { processLinearSyncBatch } from '@/lib/linear-sync/worker'

export const runtime = 'nodejs'
export const maxDuration = 60

async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  return Response.json(await processLinearSyncBatch())
}

export const GET = withRequestLog('/api/cron/linear-sync', handleGET)
