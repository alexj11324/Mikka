import { cronUnauthorized } from '@/lib/cron-auth'
import { cronJob } from '@/lib/background'
import { pool } from '@/lib/db'
import { subscriptionRuntime } from '@/lib/subscription-runtime'
import { subscriptionCleanupDue } from '@/lib/subscription-acquire-expiry'
import { byosEnabled, byosEnrollmentEnabled } from '@/lib/cloud-computer-flag'

export const runtime = 'nodejs'
export const maxDuration = 60

/** BYOS-only durable deletion queue, called hourly by the minute Worker (#1371): abandoned sign-ins past their
 * deadline expire, and secret artifacts are cleaned up. An hour with neither costs one statement. No secret
 * values enter this HTTP handler. */
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  if (!byosEnabled() && !byosEnrollmentEnabled()) return Response.json({ enabled: false })
  try {
    if (!await subscriptionCleanupDue(pool)) return Response.json({ expired: 0, processed: 0, results: [] })
    return Response.json(await subscriptionRuntime(false, true).cleanupBatch())
  }
  catch { return Response.json({ error: 'subscription_cleanup_unavailable' }, { status: 503 }) }
}

export const GET = cronJob('subscriptions', handleGET)
