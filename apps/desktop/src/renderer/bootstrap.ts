import type { OnboardingComputer } from '@/components/onboarding/onboarding'
import { withBasePath } from '@/lib/base-path'
import type { DesktopSession } from './host'
import { callAction, DesktopTransportError } from './rpc'
import type { DesktopPublicConfiguration } from './client-configuration'

export type AuthConfiguration = { googleEnabled: boolean; githubEnabled: boolean; emailEnabled: boolean } & Partial<DesktopPublicConfiguration>
export type DesktopBootstrap = AuthConfiguration & {
  user: DesktopSession['user'] | null
  session: DesktopSession['session'] | null
  onboarding?: { computer: OnboardingComputer }
}

/** One authenticated bootstrap replaces the server page's initial read. An
 * unsigned window only asks for public sign-in choices, never a bearer token. */
export async function readBootstrap(): Promise<DesktopBootstrap> {
  try {
    const value = await callAction<AuthConfiguration & DesktopSession & { onboarding: boolean; computer: OnboardingComputer }>('desktop.bootstrap', [])
    return { user: value.user, session: value.session, googleEnabled: value.googleEnabled, githubEnabled: value.githubEnabled, emailEnabled: value.emailEnabled, features: value.features, daemonPackageName: value.daemonPackageName, ...(value.onboarding ? { onboarding: { computer: value.computer } } : {}) }
  }
  catch (error) {
    if (!(error instanceof DesktopTransportError) || error.code !== 'desktop_session_expired') throw error
    const response = await fetch(withBasePath('/api/desktop/config'), { cache: 'no-store', credentials: 'omit' })
    if (!response.ok) throw new DesktopTransportError('desktop_backend_unreachable')
    const configuration = await response.json() as AuthConfiguration
    return { ...configuration, user: null, session: null }
  }
}
