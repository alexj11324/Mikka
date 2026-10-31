import 'server-only'
import { killSwitches } from '@/lib/feature-flags'
import { serverFlagEnabled } from '@/lib/posthog-server'

/**
 * Whether the sign-in and sign-up pages offer email and password. The switch is
 * one deployment-wide PostHog flag, read for a fixed distinct id because the
 * visitor is not signed in yet.
 */
export async function emailSignInEnabled(): Promise<boolean> {
  return !(await serverFlagEnabled(killSwitches.emailSignIn, 'auth-pages'))
}
