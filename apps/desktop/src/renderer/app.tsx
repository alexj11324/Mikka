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
import { InvitationCard } from '@/components/workspace/invitation-card'
import { DeviceAuthorization } from '@/components/device-authorization'
import NotFound from '@/app/[locale]/not-found'
import { safeAuthReturn } from '@/lib/auth-return'
import { setSession } from './auth-client'
import { AuthForm } from './auth-form'
import { readBootstrap, type DesktopBootstrap } from './bootstrap'
import { rendererHost } from './host'
import { Link } from './i18n-navigation'
import { localeOf, navigate, REFRESH_EVENT, useLocation, withoutLocale } from './location'
import { openCurrentPageInBrowser } from './open-settings'
import { getTransportState, setTransportState, subscribeTransport } from './transport-state'
import { Offline } from './offline'

const Workspace = lazy(() => import('./workspace'))

/** Runtime-specific composition only. The application surfaces below are the
 * exact same components, data hooks and lazy chunks as the web application. */
export function App() {
  const location = useLocation()
  const locale = localeOf(location.pathname)
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  return <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : zh} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}>
    <ThemeProvider><SWRDefaults><RendererBoundary><SessionApplication /></RendererBoundary></SWRDefaults><Toaster /></ThemeProvider>
  </NextIntlClientProvider>
}

function SessionApplication() {
  const [bootstrap, setBootstrap] = useState<DesktopBootstrap | null>(null)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(true)
  const generation = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)
  const state = useSyncExternalStore(subscribeTransport, getTransportState, getTransportState)
  const reload = useCallback((changedOwner = false) => {
    if (inFlight.current && !changedOwner) return inFlight.current
    if (changedOwner) { setSession(null); setBootstrap(null) }
    const current = ++generation.current
    setPending(true)
    inFlight.current = readBootstrap().then(value => {
      if (current !== generation.current) return
      setSession(value.user && value.session ? { user: value.user, session: value.session } : null)
      setBootstrap(value)
      setFailed(false)
      setTransportState('ready')
    }).catch(() => {
      if (current === generation.current) setFailed(true)
    }).finally(() => {
      if (current === generation.current) { setPending(false); inFlight.current = null }
    })
    return inFlight.current
  }, [])
  useEffect(() => {
    void reload()
    const changed = () => { void reload() }
    const sessionChanged = () => { void reload(true) }
    const offline = () => setTransportState('offline')
    const stop = rendererHost().onSessionChanged(sessionChanged)
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
    // A confirmed expiry discards every owner-scoped cache together. Network
    // failures retain the visible conversation and its unsent local draft.
    if (state === 'unauthenticated' && bootstrap?.user) {
      setSession(null)
      setBootstrap(current => current ? { ...current, user: null, session: null, onboarding: undefined } : null)
    }
  }, [state, bootstrap?.user])
  if (state === 'update-required') return <UpdateRequired />
  if (!bootstrap) return failed ? <Offline pending={pending} retry={() => void reload()} /> : <WorkspaceLoading />
  return <><ConnectionStatus offline={state === 'offline' || failed} retry={() => void reload()} /><AccountCache key={bootstrap.user?.id ?? 'signed-out'}><Routes bootstrap={bootstrap} /></AccountCache></>
}

function AccountCache({ children }: { children: ReactNode }) {
  const [config] = useState(() => ({ provider: () => new Map() }))
  return <SWRConfig value={config}>{children}</SWRConfig>
}

function Routes({ bootstrap }: { bootstrap: DesktopBootstrap }) {
  const location = useLocation()
  const path = withoutLocale(location.pathname)
  const query = location.searchParams
  const locale = localeOf(location.pathname)
  const user = bootstrap.user
  const authentication = path === '/sign-in' || path === '/sign-up'
  const invitation = /^\/invite\/([^/]+)$/.exec(path)
  const browserRoute = path === '/forgot-password' || path === '/reset-password' || path === '/verify-email' || path === '/oauth/consent' || path.startsWith('/a/')
  useEffect(() => {
    if (path === '/dashboard') navigate(`/${location.search}`, true, { locale }, true)
    else if (path === '/devices') navigate('/settings?section=devices', true, { locale }, true)
    else if (user && authentication && query.get('addAccount') !== '1') navigate(safeAuthReturn(query.get('next') ?? undefined), true, { locale }, true)
    else if (!user && !authentication && !invitation && !browserRoute) {
      const next = safeAuthReturn(`${path}${location.search}`)
      navigate(`/sign-in${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`, true, { locale }, true)
    }
  }, [location.href, user?.id])
  if (browserRoute || path === '/sign-up') return <BrowserRoute signUp={path === '/sign-up'} />
  if (invitation) return <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-5"><InvitationCard token={/^[a-f0-9]{64}$/.test(invitation[1]) ? invitation[1] : ''} email={user?.email ?? null} /></main>
  if (authentication || !user) return <AuthForm key={path} mode={path === '/sign-up' ? 'sign-up' : 'sign-in'} addAccount={query.get('addAccount') === '1'} next={query.get('next') ?? undefined} googleEnabled={bootstrap.googleEnabled} githubEnabled={bootstrap.githubEnabled} emailEnabled={bootstrap.emailEnabled} oauthFailed={query.get('oauth') === 'failed' || query.has('error')} />
  if (path === '/device') return <DeviceAuthorization account={user.email} initialCode={query.get('user_code') ?? ''} />
  if (path === '/workspaces/new') return <NewWorkspace email={user.email} />
  if (path === '/devices') return <WorkspaceLoading />
  if (path !== '/' && path !== '/dashboard' && !['/settings', '/settings/teams', '/settings/members'].includes(path)) return <NotFound />
  return <Suspense fallback={<WorkspaceLoading />}><Workspace user={user} bootstrap={bootstrap} /></Suspense>
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
    if (offline) toast.error(t('serverUnavailable'), { id: 'desktop-offline', duration: Infinity, description: t('offlineHint'), action: { label: t('retry'), onClick: retry } })
    else toast.dismiss('desktop-offline')
    return () => { toast.dismiss('desktop-offline') }
  }, [offline, t])
  return null
}

function BrowserRoute({ signUp = false }: { signUp?: boolean }) {
  const t = useTranslations('DesktopRenderer')
  const [failed, setFailed] = useState(false)
  const location = useLocation()
  const open = useCallback(() => {
    setFailed(false)
    if (signUp) void rendererHost().signIn({ mode: 'sign-up', next: safeAuthReturn(location.searchParams.get('next') ?? undefined), locale: localeOf(location.pathname), addAccount: location.searchParams.get('addAccount') === '1' }).catch(() => setFailed(true))
    else void openCurrentPageInBrowser().then(result => setFailed(result !== 'desktop')).catch(() => setFailed(true))
  }, [signUp, location.href])
  useEffect(open, [open])
  return <Auth><AuthCard title={t('browserTitle')} description={t(failed ? 'browserFailed' : 'browserOpened')}>
    <Button onClick={open}>{t('openBrowser')}</Button><Link href="/" className={buttonVariants({ variant: 'ghost' })}>{t('back')}</Link>
  </AuthCard></Auth>
}

function UpdateRequired() {
  const t = useTranslations('DesktopRenderer')
  return <Auth><AuthCard title={t('updateTitle')} description={t('updateHint')}>
    <Button onClick={() => void window.mikka?.app.requireUpdate?.()}>{t('checkUpdate')}</Button>
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
