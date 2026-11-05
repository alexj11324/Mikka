import type { OnboardingComputer } from '@/components/onboarding/onboarding'
import { withBasePath } from '@/lib/base-path'
import type { DesktopBootstrap as WireBootstrap } from '@/lib/desktop-rpc/wire'
import type { DesktopSession } from './host'
import { callAction, DesktopTransportError } from './rpc'
import type { DesktopPublicConfiguration } from './client-configuration'

export type AuthConfiguration = { googleEnabled: boolean; githubEnabled: boolean; emailEnabled: boolean } & Partial<DesktopPublicConfiguration>
export type DesktopBootstrap = AuthConfiguration & {
  user: DesktopSession['user'] | null
  session: DesktopSession['session'] | null
  onboarding?: { computer: OnboardingComputer }
  cacheWorkspace: WireBootstrap['cacheWorkspace']
}

/** One authenticated bootstrap replaces the server page's initial read. An
 * unsigned window only asks for public sign-in choices, never a bearer token. */
export async function readBootstrap(workspaceId?: string | null): Promise<DesktopBootstrap> {
  const requested = workspaceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId) ? workspaceId : undefined
  try {
    const value = await callAction<WireBootstrap>('desktop.bootstrap', requested ? [requested] : [])
    return { user: value.user, session: value.session, cacheWorkspace: workspaceId && !requested ? null : value.cacheWorkspace, googleEnabled: value.googleEnabled, githubEnabled: value.githubEnabled, emailEnabled: value.emailEnabled, features: value.features, daemonPackageName: value.daemonPackageName, ...(value.onboarding ? { onboarding: { computer: value.computer } } : {}) }
  }
  catch (error) {
    if (!(error instanceof DesktopTransportError) || error.code !== 'desktop_session_expired') throw error
    const response = await fetch(withBasePath('/api/desktop/config'), { cache: 'no-store', credentials: 'omit' })
    if (!response.ok) throw new DesktopTransportError('desktop_backend_unreachable', { status: response.status })
    const configuration = await response.json() as AuthConfiguration
    return { ...configuration, user: null, session: null, cacheWorkspace: null }
  }
}
