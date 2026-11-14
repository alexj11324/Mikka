import 'server-only'
import { headers } from 'next/headers'
import { afterJob } from '@/lib/background'
import { serverPostHog } from '@/lib/posthog-server'
import { isSmokeAccountEmail } from '@/lib/smoke-account'
import { parseFirstTouch } from '@/lib/first-touch.mjs'

type FirstTouch = { source: string; acquired_at: number; landing_path: string; referrer_domain?: string | null; utm_source?: string | null; utm_medium?: string | null; utm_campaign?: string | null; utm_content?: string | null; utm_term?: string | null }

/**
 * Only Better Auth's user.create.after hook calls this. Its database insert
 * is the unique registration boundary; logins and failed sign-ups never fire.
 * Attribution is client-supplied and must NEVER be used for authorization,
 * billing or other trusted business decisions.
 */
export async function trackNewRegistration(user: { id: string; email?: string | null }) {
  let firstTouch: FirstTouch | null = null
  try {
    // Read while the Better Auth request context is still alive. OAuth
    // callbacks also return through this same top-level App origin.
    firstTouch = parseFirstTouch((await headers()).get('cookie') ?? '')
  } catch {
    // Outside an HTTP request (CLI or isolated setup), no referrer is known.
  }

  const properties: Record<string, string | number | boolean> = {
    app: 'mikka',
    test_account: isSmokeAccountEmail(user.email),
    acquisition_source: firstTouch?.source ?? 'unknown',
    acquisition_medium: firstTouch?.utm_medium ?? (firstTouch?.referrer_domain ? 'referral' : 'unknown'),
    acquisition_landing_path: firstTouch?.landing_path ?? 'unknown',
  }
  if (firstTouch?.referrer_domain) properties.acquisition_referrer_domain = firstTouch.referrer_domain
  if (firstTouch) {
    properties.acquisition_at = Math.floor(firstTouch.acquired_at / 1000)
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const) {
      if (firstTouch[key]) properties[`acquisition_${key}`] = firstTouch[key]
    }
  }

  try {
    // Flush in Next's after() window so short-lived serverless instances do
    // not lose queued registrations, without adding network latency to sign-up.
    afterJob('after:registration-analytics', async () => {
      const client = serverPostHog()
      if (!client) return
      client.capture({ distinctId: user.id, event: 'registration_completed', properties })
      await client.flush()
    })
  } catch (error) {
    // Analytics never blocks a newly created account.
    console.error('Registration analytics scheduling failed', error instanceof Error ? error.name : 'UnknownError')
  }
}
