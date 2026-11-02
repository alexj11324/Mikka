import { verifyBearer } from '@/lib/linear-sync/webhook'
import { subscriptionRuntime } from '@/lib/subscription-runtime'
import { byosEnabled, byosEnrollmentEnabled } from '@/lib/cloud-computer-flag'

export const runtime = 'nodejs'
export const maxDuration = 60

// BYOS-only durable deletion queue. No secret values enter this HTTP handler.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  if (!byosEnabled() && !byosEnrollmentEnabled()) return Response.json({ enabled: false })
  try { return Response.json(await subscriptionRuntime(false, true).cleanupBatch()) }
  catch { return Response.json({ error: 'subscription_cleanup_unavailable' }, { status: 503 }) }
}
