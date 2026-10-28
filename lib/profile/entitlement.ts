import 'server-only'
import { proactiveFeatures } from '@/lib/feature-flags'
import { serverFlagEnabled } from '@/lib/posthog-server'
import { profileEnabled } from './flags'

/**
 * Whether the person may have a profile built (proactive.md § 3): the
 * deployment's PROACTIVE_PROFILE_ENABLED and their PostHog flag
 * `mikka-proactive-profile`. Fails closed. The person's own 记忆 switch and
 * the daily cap are checked by the caller.
 */
export async function profileEntitled(userId: string): Promise<boolean> {
  return profileEnabled() && serverFlagEnabled(proactiveFeatures.profile, userId)
}
