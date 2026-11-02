import { cronUnauthorized } from '@/lib/cron-auth'
import { subscriptionRuntime } from '@/lib/subscription-runtime'

export const runtime = 'nodejs'
export const maxDuration = 60

// BYOS-only durable deletion queue. No secret values enter this HTTP handler.
export async function GET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  if (process.env.MIKKA_BYOS_ENABLED !== '1' && process.env.MIKKA_BYOS_ENROLLMENT_ENABLED !== '1') return Response.json({ enabled: false })
  try { return Response.json(await subscriptionRuntime(false, true).cleanupBatch()) }
  catch { return Response.json({ error: 'subscription_cleanup_unavailable' }, { status: 503 }) }
}
