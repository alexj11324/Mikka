import { useEffect, useState, type ComponentProps } from 'react'
import { AuthForm as ExistingAuthForm } from '@/components/auth-form'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'
import { VerifyEmailForm } from '@/components/auth/verify-email-form'
import { OAuthConsent } from '@/components/oauth-consent'
import { WorkspaceLoading } from '@/components/workspace/workspace-loading'
import { VersionGuard } from '@/components/version-guard'
import { PostHogAnalytics } from '@/components/posthog-analytics'
import { posthogConfig } from '@/lib/posthog-config'
import { authClient, cloudAuthClient } from '@/lib/auth-client'
import { withBasePath } from '@/lib/base-path'
import { isInvitationPath, serverDocumentKind } from '@/lib/server-pages'
import { bridgeFromWindow } from '@/lib/platform/detect'
import { navigate, useLocation, withoutLocale } from '../../../desktop/src/renderer/location'
import type { DesktopSession } from '../../../desktop/src/renderer/host'
import type { BootstrapScope } from '../../../desktop/src/renderer/bootstrap'
import { isDesktopHandoffPage, webAuthentication } from './auth-routing'
import { watchSessionOwner } from './session-owner'
import { currentWebServers, subscribeWebServers } from '@/lib/web-connection/browser'

export { authenticatedReturn } from './auth-routing'
export const platform = 'web' as const

function isInvitationHandoff(location: URL): boolean {
  const path = withoutLocale(location.pathname)
  if (path !== '/sign-in' && path !== '/sign-up') return isInvitationPath(path)
  // The two links on the invitation card supply exactly one validated return destination.
  const next = webAuthentication(location).next
  return !location.hash && location.searchParams.size === 1
    && next === location.searchParams.get('next') && isInvitationPath(next)
}

/** Invitation acceptance and the sign-in or sign-up return require only the current session. */
export function bootstrapScope(location: URL): BootstrapScope {
  const documentKind = serverDocumentKind()
  const invitation = (documentKind === null || documentKind === 'authentication') && isInvitationHandoff(location)
  return typeof window !== 'undefined' && !bridgeFromWindow(window) && (isDesktopHandoffPage(location) || invitation)
    ? 'authentication' : 'workspace'
}

export function AuthForm(props: ComponentProps<typeof ExistingAuthForm>) {
  const location = useLocation()
  const { oauthResume: _oauth, composioResume: _composio, desktopRefused: _refused, ...auth } = webAuthentication(location)
  return <ExistingAuthForm {...props} {...auth} />
}

// Better Auth owns the web's cookie session store. Bootstrap's safe projection
// is for application composition; it is never inserted as a fabricated SDK
// session or assigned to its credential-bearing internal fields.
export function setSession(_session: DesktopSession | null) {}

export function onSessionChanged(changed: () => void) {
  const stopRemote = subscribeWebServers(changed)
  const stopIdentities = cloudAuthClient.$store.atoms.session.subscribe(value => {
    if (!value.isPending && !value.error && value.data?.user.id) void currentWebServers()?.rememberCloudAccounts([value.data.user.id])
  })
  const stopCloud = watchSessionOwner(authClient.$store.atoms.session, () => {
    if (!currentWebServers()?.getActiveAccount()) changed()
  })
  return () => { stopRemote(); stopCloud(); stopIdentities() }
}

export function PlatformExtras() {
  return <>{posthogConfig.token && <PostHogAnalytics />}<VersionGuard /></>
}

/** These are the original browser forms, not the desktop's browser-handoff
 * notice. The independent API retains the narrow consent metadata read. */
export function BrowserRoute({ account }: { signUp?: boolean; account?: string | null }) {
  const location = useLocation()
  const path = withoutLocale(location.pathname)
  if (path === '/forgot-password') return <ForgotPasswordForm />
  if (path === '/reset-password') return <ResetPasswordForm />
  if (path === '/verify-email') return <VerifyEmailForm />
  return <ConsentRoute account={account ?? null} />
}

function ConsentRoute({ account }: { account: string | null }) {
  const location = useLocation()
  const [client, setClient] = useState<{ clientName: string | null; clientUri: string | null } | null>(null)
  const [failure, setFailure] = useState<Error | null>(null)
  const clientIds = location.searchParams.getAll('client_id')
  const clientId = clientIds.length === 1 ? clientIds[0] : ''
  useEffect(() => {
    if (!account) { navigate('/sign-in', true, undefined, true); return }
    const abort = new AbortController()
    const url = new URL(withBasePath('/api/frontend/oauth-consent'), window.location.origin)
    if (clientId) url.searchParams.set('client_id', clientId)
    void fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal }).then(async response => {
      if (response.status === 401) { navigate('/sign-in', true, undefined, true); return }
      if (!response.ok) throw new Error('desktop_request_failed')
      const value = await response.json() as { clientName: string | null; clientUri: string | null }
      if (!abort.signal.aborted) setClient(value)
    }).catch(error => { if (!abort.signal.aborted) setFailure(error instanceof Error ? error : new Error('desktop_request_failed', { cause: error })) })
    return () => abort.abort()
  }, [account, clientId])
  if (failure) throw failure
  return account && client ? <OAuthConsent account={account} {...client} /> : <WorkspaceLoading />
}

export function requireUpdate() { window.location.reload() }
