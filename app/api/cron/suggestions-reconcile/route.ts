import { withRequestLog } from '@/lib/request-log'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { redeliverFailedGitHubWebhooks } from '@/lib/suggestions/github-redelivery'

export const runtime = 'nodejs'
export const maxDuration = 60

async function handleGET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  const result = await redeliverFailedGitHubWebhooks()
  return Response.json(result, {
    status: !result.configured ? 503 : result.errors ? 502 : 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export const GET = withRequestLog('/api/cron/suggestions-reconcile', handleGET)
