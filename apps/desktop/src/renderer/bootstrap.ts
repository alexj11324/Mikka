import type { OnboardingComputer } from '@/components/onboarding/onboarding'
import { withBasePath } from '@/lib/base-path'
import type { DesktopBootstrap as WireBootstrap } from '@/lib/desktop-rpc/wire'
import type { DesktopSession } from './host'
import { callAction, DesktopTransportError } from './rpc'
import type { DesktopPublicConfiguration } from './client-configuration'
import { markStartup } from '../startup'

export type AuthConfiguration = { googleEnabled: boolean; githubEnabled: boolean; emailEnabled: boolean } & Partial<DesktopPublicConfiguration>
export type DesktopBootstrap = AuthConfiguration & {
  user: DesktopSession['user'] | null
  session: DesktopSession['session'] | null
  onboarding?: { computer: OnboardingComputer }
  cacheWorkspace: WireBootstrap['cacheWorkspace']
}
export type BootstrapScope = 'authentication' | 'workspace'
export type AuthenticationBootstrap = Pick<DesktopBootstrap, 'user' | 'session' | 'googleEnabled' | 'githubEnabled' | 'emailEnabled'>

/** A system-browser PKCE page needs identity and login methods, never a
 * workspace authorization or an owner-evaluated feature snapshot. */
export async function readAuthentication(isCurrent?: () => boolean): Promise<AuthenticationBootstrap> {
  const [identity, configuration] = await Promise.all([
    callAction<DesktopSession | null>('desktop.session', [], isCurrent).catch(error => {
      if (error instanceof DesktopTransportError && error.code === 'desktop_session_expired') return null
      throw error
    }),
    readPublicConfiguration(),
  ])
  return { user: identity?.user ?? null, session: identity?.session ?? null,
    googleEnabled: configuration.googleEnabled, githubEnabled: configuration.githubEnabled, emailEnabled: configuration.emailEnabled }
}

async function readPublicConfiguration(): Promise<AuthConfiguration> {
  const response = await fetch(withBasePath('/api/desktop/config'), { cache: 'no-store', credentials: 'omit' })
  if (response.status === 401 && (await response.json().catch(() => null))?.error === 'web_auth_session_expired') {
    // The Web directory pins this browser to its revoked installation. The
    // sign-in screen offers that server's reconnect control without local providers.
    return { googleEnabled: false, githubEnabled: false, emailEnabled: false }
  }
  if (!response.ok) throw new DesktopTransportError('desktop_backend_unreachable', { status: response.status })
  return response.json() as Promise<AuthConfiguration>
}

/** One authenticated bootstrap replaces the server page's initial read. An
 * unsigned window only asks for public sign-in choices, never a bearer token. */
export async function readBootstrap(workspaceId?: string | null, isCurrent?: () => boolean): Promise<DesktopBootstrap> {
  markStartup('renderer.bootstrap.start')
  try { return await fetchBootstrap(workspaceId, isCurrent) }
  finally { markStartup('renderer.bootstrap.end') }
}

async function fetchBootstrap(workspaceId?: string | null, isCurrent?: () => boolean): Promise<DesktopBootstrap> {
  const requested = workspaceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId) ? workspaceId : undefined
  try {
    const value = await callAction<WireBootstrap>('desktop.bootstrap', requested ? [requested] : [], isCurrent)
    return { user: value.user, session: value.session, cacheWorkspace: workspaceId && !requested ? null : value.cacheWorkspace, googleEnabled: value.googleEnabled, githubEnabled: value.githubEnabled, emailEnabled: value.emailEnabled, features: value.features, daemonPackageName: value.daemonPackageName, ...(value.onboarding ? { onboarding: { computer: value.computer } } : {}) }
  }
  catch (error) {
    if (!(error instanceof DesktopTransportError) || error.code !== 'desktop_session_expired') throw error
    const configuration = await readPublicConfiguration()
    return { ...configuration, user: null, session: null, cacheWorkspace: null }
  }
}
