import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { NextIntlClientProvider, useTranslations } from 'next-intl'
import { SWRConfig } from 'swr'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import en from '@/messages/en.json'
import zh from '@/messages/zh-CN.json'
import { ThemeProvider } from '@/components/theme-provider'
import { SWRDefaults } from '@/components/swr-defaults'
import { Toaster } from '@/components/ui/sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { AuthCard } from '@/components/blocks/auth-19/components/auth-card'
import { WorkspaceLoading } from '@/components/workspace/workspace-loading'
import { CreateWorkspaceForm } from '@/components/workspace/create-workspace-form'
import { InvitationCard, OrganizationInvitationCard } from '@/components/workspace/invitation-card'
import { DeviceAuthorization } from '@/components/device-authorization'
import NotFound from '@/components/app-shell/not-found'
import { safeAuthReturn } from '@/lib/auth-return'
import { withBasePath } from '@/lib/base-path'
import { clearPersistentReadCaches } from '@/lib/swr/persistent-cache'
import { readAuthentication, readBootstrap, type AuthenticationBootstrap, type BootstrapScope, type DesktopBootstrap } from './bootstrap'
import { Link } from './i18n-navigation'
import { localeOf, navigate, REFRESH_EVENT, useLocation, withoutLocale } from './location'
import { getTransportState, setTransportState, subscribeTransport } from './transport-state'
import { resetReadBatchScope } from './read-batch'
import { Offline } from './offline'
import { setClientConfiguration } from './client-configuration'
import { platform, AuthForm, BrowserRoute, setSession, onSessionChanged, authenticatedReturn, bootstrapScope, PlatformExtras, requireUpdate } from 'mikka:platform'
import { loadWorkspace, preloadWorkspace } from './workspace-loader'
import { InstalledWorkspace } from './installed-workspace'
import { mobileTaskLaunch } from '@/lib/mobile-task-handoff'
import { DesktopTabs } from './desktop-tabs'
import { serverDocumentKind, serverPageKind } from '@/lib/server-pages'

const MobileTaskHandoff = lazy(() => import('@/components/mobile-task-handoff'))
const ServerStatus = lazy(() => import('@/components/server-status'))
const Workspace = lazy(loadWorkspace)
const SharedArtifactRoute = lazy(() => import('./deep-link-routes').then(module => ({ default: module.SharedArtifactRoute })))
const WorkspaceLinkRoute = lazy(() => import('./deep-link-routes').then(module => ({ default: module.WorkspaceLinkRoute })))
const GitHubHandoff = lazy(() => import('@/components/plugins/github-settings').then(module => ({ default: module.GitHubSettings })))

type ApplicationBootstrap =
  | { scope: 'authentication'; value: AuthenticationBootstrap }
  | { scope: 'workspace'; workspace: string | null; value: DesktopBootstrap }

/** Runtime-specific composition only. The application surfaces below are the
 * exact same components, data hooks and lazy chunks as the web application. */
export function App() {
  const location = useLocation()
  const locale = localeOf(location.pathname)
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  const status = platform === 'web' && serverDocumentKind() === 'status'
  const mobileTask = platform === 'web' && !serverDocumentKind() ? mobileTaskLaunch(location) : null
  return <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : zh} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}>
    <ThemeProvider>
      <>
        <DesktopTabs />
        {mobileTask
          ? <RendererBoundary><Suspense fallback={<WorkspaceLoading />}><MobileTaskHandoff key={location.href} launch={mobileTask} /></Suspense></RendererBoundary>
          : status
            ? <RendererBoundary><Suspense fallback={<WorkspaceLoading />}><ServerStatus /></Suspense></RendererBoundary>
            : <><PlatformExtras /><SWRDefaults><RendererBoundary><SessionApplication /></RendererBoundary></SWRDefaults><Toaster /></>}
      </>
    </ThemeProvider>
  </NextIntlClientProvider>
}

function SessionApplication() {
  const [bootstrap, setBootstrap] = useState<ApplicationBootstrap | null>(null)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(true)
  const location = useLocation()
  const requestedScope = bootstrapScope(location)
  const workspacePage = ['/', '/dashboard', '/settings', '/settings/teams', '/settings/members'].includes(withoutLocale(location.pathname))
  const requestedWorkspace = requestedScope === 'workspace' && workspacePage && !serverDocumentKind() ? location.searchParams.get('workspace') : null
  const requested = useRef({ scope: requestedScope, workspace: requestedWorkspace })
  requested.current = { scope: requestedScope, workspace: requestedWorkspace }
  const lastRequested = useRef(requested.current)
  const generation = useRef(0)
  const inFlight = useRef<{ scope: BootstrapScope; workspace: string | null; promise: Promise<void> } | null>(null)
  const state = useSyncExternalStore(subscribeTransport, getTransportState, getTransportState)
  const reload = useCallback((changedOwner = false) => {
    const request = requested.current
    if (inFlight.current?.scope === request.scope && inFlight.current.workspace === request.workspace && !changedOwner) return inFlight.current.promise
    const changedScope = changedOwner || request.scope !== lastRequested.current.scope || request.workspace !== lastRequested.current.workspace
    lastRequested.current = request
    if (changedScope) { resetReadBatchScope(); setBootstrap(null) }
    if (changedOwner) { setClientConfiguration(null); setSession(null) }
    const current = ++generation.current
    setPending(true)
    // Record this request before clearing the old provider: its shared
    // invalidation calls router.refresh(), which should join this same read.
    const promise = Promise.resolve().then(async () => {
      if (changedScope) await clearPersistentReadCaches()
      if (current !== generation.current) return
      const isCurrent = () => current === generation.current
      const value: ApplicationBootstrap = request.scope === 'authentication'
        ? { scope: 'authentication', value: await readAuthentication(isCurrent) }
        : { scope: 'workspace', workspace: request.workspace, value: await readBootstrap(request.workspace, isCurrent) }
      if (current !== generation.current) return
      if (!value.value.user) await clearPersistentReadCaches()
      if (current !== generation.current) return
      setClientConfiguration(value.scope === 'workspace' ? value.value : null)
      setSession(value.value.user && value.value.session ? { user: value.value.user, session: value.value.session } : null)
      setBootstrap(value)
      setFailed(false)
      setTransportState('ready')
    }).catch(() => {
      if (current === generation.current) setFailed(true)
    }).finally(() => {
      if (current === generation.current) { setPending(false); inFlight.current = null }
    })
    inFlight.current = { ...request, promise }
    return promise
  }, [])
  useEffect(() => {
    void reload()
    // Load only installed code in parallel with bootstrap. The shared provider
    // and all business effects remain behind the authenticated Routes boundary.
    void preloadWorkspace().catch(() => {})
    const changed = () => { void reload() }
    const sessionChanged = () => { void reload(true) }
    const offline = () => setTransportState('offline')
    const stop = onSessionChanged(sessionChanged)
    window.addEventListener(REFRESH_EVENT, changed)
    window.addEventListener('online', changed)
    window.addEventListener('offline', offline)
    return () => {
      generation.current++
      stop()
      window.removeEventListener(REFRESH_EVENT, changed)
      window.removeEventListener('online', changed)
      window.removeEventListener('offline', offline)
    }
  }, [reload])
  useEffect(() => {
    // Leaving a PKCE identity page needs full workspace authorization even
    // when both routes have the same selector. Ordinary application navigation
    // keeps its existing hydrated provider.
    if (requestedScope !== lastRequested.current.scope || requestedWorkspace !== lastRequested.current.workspace) void reload()
  }, [requestedScope, requestedWorkspace, reload])
  useEffect(() => {
    // A confirmed expiry discards every owner-scoped cache together. Network
    // failures retain the visible conversation and its unsent local draft.
    if (state === 'unauthenticated' && bootstrap?.value.user) {
      resetReadBatchScope()
      generation.current++
      inFlight.current = null
      setClientConfiguration(null)
      setSession(null)
      setBootstrap(current => !current ? null : current.scope === 'workspace'
        ? { ...current, value: { ...current.value, user: null, session: null, cacheWorkspace: null, onboarding: undefined } }
        : { ...current, value: { ...current.value, user: null, session: null } })
      void clearPersistentReadCaches()
    }
  }, [state, bootstrap?.value.user])
  if (state === 'update-required') return <UpdateRequired />
  if (!bootstrap || bootstrap.scope !== requestedScope || (bootstrap.scope === 'workspace' && bootstrap.workspace !== requestedWorkspace))
    return failed ? <Offline pending={pending} retry={() => void reload()} /> : <WorkspaceLoading />
  return <><ConnectionStatus offline={state === 'offline' || failed} retry={() => void reload()} /><AccountCache key={bootstrap.value.user?.id ?? 'signed-out'}><Routes bootstrap={bootstrap} /></AccountCache></>
}

function AccountCache({ children }: { children: ReactNode }) {
  const [config] = useState(() => ({ provider: () => new Map() }))
  return <SWRConfig value={config}>{children}</SWRConfig>
}

function Routes({ bootstrap }: { bootstrap: ApplicationBootstrap }) {
  const location = useLocation()
  const path = withoutLocale(location.pathname)
  const query = location.searchParams
  const locale = localeOf(location.pathname)
  const user = bootstrap.value.user
  const serverDocument = platform === 'web' ? serverDocumentKind() : null
  const authentication = path === '/sign-in' || path === '/sign-up'
  const invitation = /^\/invite\/([^/]+)$/.exec(path)
  const organizationInvitation = /^\/organization-invite\/([^/]+)$/.exec(path)
  const sharedArtifact = /^\/a\/([^/]+)$/.exec(path)
  const workspaceLink = /^\/w\/([a-z0-9]([a-z0-9-]{1,62}[a-z0-9]))$/.exec(path)
  const browserRoute = path === '/forgot-password' || path === '/reset-password' || path === '/verify-email' || path === '/oauth/consent'
  useEffect(() => {
    if (serverDocument && !serverPageKind(location)) { window.location.replace(withBasePath('/')); return }
    if (path === '/dashboard') navigate(`/${location.search}`, true, { locale }, true)
    else if (path === '/devices') navigate('/settings?section=devices', true, { locale }, true)
    else if (user && authentication) {
      const destination = authenticatedReturn(location)
      if (destination !== null) navigate(destination, true)
    }
    else if (!user && !authentication && !invitation && !organizationInvitation && !browserRoute && !sharedArtifact) {
      const next = safeAuthReturn(`${path}${location.search}`)
      navigate(`/sign-in${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`, true, { locale }, true)
    }
  }, [location.href, user?.id, serverDocument])
  if (browserRoute || (platform === 'desktop' && path === '/sign-up')) return <BrowserRoute signUp={path === '/sign-up'} account={user?.email ?? null} />
  if (sharedArtifact) return <Suspense fallback={<WorkspaceLoading />}><SharedArtifactRoute key={sharedArtifact[1]} token={sharedArtifact[1]} /></Suspense>
  if (invitation) return <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-5"><InvitationCard token={/^[a-f0-9]{64}$/.test(invitation[1]) ? invitation[1] : ''} email={user?.email ?? null} /></main>
  if (organizationInvitation) return <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-5"><OrganizationInvitationCard token={/^[a-f0-9]{64}$/.test(organizationInvitation[1]) ? organizationInvitation[1] : ''} email={user?.email ?? null} /></main>
  if (authentication || !user) return <AuthForm key={path} mode={path === '/sign-up' ? 'sign-up' : 'sign-in'} addAccount={query.get('addAccount') === '1'} next={query.get('next') ?? undefined} googleEnabled={bootstrap.value.googleEnabled} githubEnabled={bootstrap.value.githubEnabled} emailEnabled={bootstrap.value.emailEnabled} oauthFailed={query.get('oauth') === 'failed' || query.has('error')} signedInAs={user ? { name: user.name, email: user.email, image: user.image } : null} />
  if (bootstrap.scope !== 'workspace') return <WorkspaceLoading />
  if (workspaceLink) return <Suspense fallback={<WorkspaceLoading />}><WorkspaceLinkRoute key={workspaceLink[1]} slug={workspaceLink[1]} /></Suspense>
  if (path === '/device') return <DeviceAuthorization account={user.email} initialCode={query.get('user_code') ?? ''} />
  if (path === '/workspaces/new') return <NewWorkspace email={user.email} />
  if (path === '/devices') return <WorkspaceLoading />
  // Reuse the existing narrow account-linking surface. A native GitHub OAuth
  // return must still finish after the surrounding community app is disabled.
  if (serverDocument && serverPageKind(location) === 'github') return <Suspense fallback={<WorkspaceLoading />}><GitHubHandoff /></Suspense>
  if (serverDocument) return <WorkspaceLoading />
  if (path !== '/' && path !== '/dashboard' && !['/settings', '/settings/teams', '/settings/members'].includes(path)) return <NotFound />
  if (bootstrap.value.workspaceError) return <WorkspaceSelectionError message={bootstrap.value.workspaceError} />
  if (platform === 'desktop') return <InstalledWorkspace user={user} bootstrap={bootstrap.value} />
  return <Suspense fallback={<WorkspaceLoading />}><Workspace user={user} bootstrap={bootstrap.value} /></Suspense>
}

function WorkspaceSelectionError({ message }: { message: string | true }) {
  const t = useTranslations()
  return <Auth><AuthCard title={t('Issue.scope.workspaceUnavailable')} description={message === true ? t('Members.noAccessDescription') : message}>
    <Button onClick={() => window.dispatchEvent(new Event(REFRESH_EVENT))}>{t('Common.retry')}</Button>
    <Link href="/" className={buttonVariants({ variant: 'outline' })}>{t('Members.backToAccessible')}</Link>
  </AuthCard></Auth>
}

function NewWorkspace({ email }: { email: string }) {
  const t = useTranslations()
  return <div className="flex min-h-dvh flex-col bg-background">
    <header className="flex items-center justify-between gap-4 px-4 py-5 sm:px-8">
      <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}><ArrowLeft data-icon="inline-start" />{t('Devices.connect.back')}</Link>
      <span className="max-w-[60%] truncate text-xs text-muted-foreground" title={email}>{email}</span>
    </header>
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col px-6 pt-12 pb-16 sm:pt-24">
      <div className="mb-10 flex flex-col gap-3"><h1 className="text-3xl font-semibold tracking-tight">{t('FeatureCopy.c_0155bce8')}</h1></div>
      <CreateWorkspaceForm />
    </main>
  </div>
}

function ConnectionStatus({ offline, retry }: { offline: boolean; retry: () => void }) {
  const t = useTranslations('DesktopRenderer')
  useEffect(() => {
    if (offline) toast.error(t('serverUnavailable'), {
      id: 'desktop-offline',
      duration: Infinity,
      position: 'top-center',
      closeButton: true,
      description: t('offlineHint'),
      action: { label: t('retry'), onClick: event => { event.preventDefault(); retry() } },
    })
    else toast.dismiss('desktop-offline')
    return () => { toast.dismiss('desktop-offline') }
  }, [offline, t])
  return null
}

function UpdateRequired() {
  const t = useTranslations('DesktopRenderer')
  return <Auth><AuthCard title={t('updateTitle')} description={t('updateHint')}>
    <Button onClick={requireUpdate}>{t('checkUpdate')}</Button>
  </AuthCard></Auth>
}

class RendererBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <RenderFailure retry={() => this.setState({ failed: false })} /> : this.props.children }
}

function RenderFailure({ retry }: { retry: () => void }) {
  const t = useTranslations('DesktopRenderer')
  return <Auth><AuthCard title={t('renderFailed')} description={t('renderHint')}><Button onClick={retry}>{t('retry')}</Button></AuthCard></Auth>
}
