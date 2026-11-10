'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, ChevronRight, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { AppTile, ToolGroup } from '@/components/plugins/connected-apps'
import { SettingsSection } from '@/components/settings/primitives'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InlineLoadError } from '@/components/load-error'
import { SearchInput } from '@/components/ui/search-input'
import { withBasePath } from '@/lib/base-path'
import { authClient, endSession } from '@/lib/auth-client'
import { openPathInBrowser } from '@/lib/platform/open-settings'
import { useCheckOnReturn, useChecksUntilDone } from '@/lib/hooks/use-check-on-return'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { GITHUB_APP_INSTALL_URL } from '@/lib/github/repository-match'
import { GitHubAppSettings } from '@/components/plugins/github-app-settings'
import { settingsHref } from '@/lib/settings-sections'

type GitHubRepository = { id: string; fullName: string; installationId: string; htmlUrl: string; private: boolean }
type GitHubState = { viewerId: string; configured: boolean; connected: boolean; source?: 'cloud' | 'own'; login?: string | null; installed: boolean; repositories: GitHubRepository[] }
/** A readable state, or an account link GitHub no longer accepts. */
type GitHubRead = { state: GitHubState; reconnect: false } | { state: null; reconnect: true }

const githubKey = (userId: string) => ['integrations:github', userId] as const
const CONNECT_PATH = withBasePath('/api/integrations/github/connect')
/** A notice, not an error: the browser is signed in as another account and nothing went wrong. */
const NOTICE = 'border-transparent bg-warning/10'
const INTENT_PATH = withBasePath('/api/integrations/github/connect/intent')
const CONFIRM_PATH = withBasePath('/api/integrations/github/connect/intent/confirm')
/** As long as the link token lives (lib/github/connect-intent.ts). */
const LINK_WINDOW_MS = 10 * 60_000
const INTENT_TOKEN = /^ghi_[A-Za-z0-9_-]{43}$/
type IntentView = { state: 'expired' } | { state: 'waiting' | 'started'; browserAccount: string | null } | { state: 'otherAccount'; browserAccount: string; appAccount: string }

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randomKey = () => base64url(crypto.getRandomValues(new Uint8Array(32)))
const s256 = async (value: string) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))

async function readIntent(token: string): Promise<IntentView> {
  const response = await fetch(`${INTENT_PATH}?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(String(response.status))
  return await response.json() as IntentView
}
const VERIFICATION_PATH = withBasePath('/api/integrations/github/repositories/verification')
const INSTALL_URL = GITHUB_APP_INSTALL_URL

/**
 * What an Agent does through this plugin, from the code that does it. Every
 * ability runs directly with the person's own GitHub credential (R-77,
 * decision 2026-11-02-1600), so none has a control: pushing the branch, the
 * pull request (lib/github/run-pull-request.ts), cloning, and the readbacks in
 * lib/github/user-access.ts and the run's checks/actions read.
 * A new ability lands here with its code.
 */
const ABILITIES = {
  write: ['push', 'pullRequest'] as const,
  read: ['readCode', 'readPullRequest', 'readIssue', 'readChecks'] as const,
}

async function readGitHub([, userId]: ReturnType<typeof githubKey>): Promise<GitHubRead> {
  const response = await fetch(withBasePath('/api/integrations/github'), { cache: 'no-store' })
  const next = await response.json() as GitHubState & { error?: string }
  if (next.viewerId !== userId) throw new Error('viewer')
  if (!response.ok) {
    if (next.error === 'githubReconnectRequired') return { state: null, reconnect: true }
    throw new Error(String(response.status))
  }
  if (typeof next.configured !== 'boolean' || typeof next.connected !== 'boolean' || typeof next.installed !== 'boolean' || !Array.isArray(next.repositories) || next.repositories.some(repository => !repository || typeof repository.id !== 'string' || typeof repository.fullName !== 'string')) throw new Error('shape')
  return { state: next, reconnect: false }
}

/** GitHub's page on 插件: header and link, what it does, the connection, repository access and its abilities. */
export function GitHubSettings() {
  const { data: session, isPending } = authClient.useSession()
  const userId = !isPending ? session?.user.id : undefined
  return <ViewerGitHubSettings key={userId ?? 'unconfirmed'} userId={userId} email={session?.user.email ?? ''} isPending={isPending} />
}

/**
 * GitHub's page as data and actions: the connection and its link (in the browser, from the desktop's loopback, or
 * through the browser signed in as another account), disconnecting, and repository access. Shared by the page below
 * and UI layers (docs/ui-overlay.md); key it by the viewer, as GitHubSettings does.
 */
export function useGitHubPlugin({ userId, email, isPending }: { userId: string | undefined; email: string; isPending: boolean }) {
  const t = useTranslations('Settings.integrations')
  // Cached across visits: a revisit shows the last state at once and re-checks it behind.
  // Every mount asks GitHub again, exactly once. Focus never does: what is shown
  // stays until the person's own action or a finished hand-off reads again.
  // SWR's own mount re-check is off: with a cached answer it waits a frame and
  // is deduplicated against the read before it, whose entry clears on a 0 ms
  // timer, so a quick revisit could skip the read. A mount effect reads instead.
  const { data, error, mutate } = useSWR(userId ? githubKey(userId) : null, readGitHub, { revalidateOnMount: false, revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 0 })
  useEffect(() => { if (userId) void mutate() }, [userId, mutate])
  const githubState = error ? null : data?.state ?? null
  const githubReconnect = !error && Boolean(data?.reconnect)
  const githubLoading = isPending || (Boolean(userId) && !data && !error)
  const githubError = error ? t('githubLoadFailed') : githubReconnect ? t('githubReconnectRequired') : ''
  const [githubLinking, setGithubLinking] = useState(false)
  const [githubLinkError, setGithubLinkError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  // From the desktop the link finishes in the system browser: every return reads again until it is done.
  // `linking` is the app's one-time link token; `browserAccount` the other account the browser was signed in as.
  const [linking, setLinking] = useState<string | null>(null)
  const [browserAccount, setBrowserAccount] = useState<string | null>(null)
  // The GitHub App installation opens in another window: read once on the way back.
  const checkOnReturn = useCheckOnReturn(() => { void mutate() })
  const returns = useChecksUntilDone(() => {
    void mutate()
    if (linking) void readIntent(linking).then(view => setBrowserAccount(view.state === 'waiting' ? view.browserAccount : null)).catch(() => {})
  })
  // The desktop's loopback return for the link in progress: its state, and the verifier only this page holds.
  const pendingReturn = useRef<{ returnState: string; verifier: string; token: string } | null>(null)
  const stopChecks = returns.stop
  useEffect(() => {
    // Not linked this time: the page stops waiting and says why.
    const notLinked = (message: string) => { stopChecks(); setLinking(null); setBrowserAccount(null); setGithubLinkError(message) }
    const bridge = bridgeFromWindow(window as MikkaWindow)
    if (!bridge || typeof bridge.app.onReturn !== 'function') return
    return bridge.app.onReturn(({ state, result }) => {
      const pending = pendingReturn.current
      if (!pending || state !== pending.returnState) return
      pendingReturn.current = null
      if (result !== 'connected') { notLinked(result === 'cancelled' ? t('githubLinkCancelled') : t('githubLinkFailed')); return }
      void fetch(CONFIRM_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: pending.token, verifier: pending.verifier }) })
        .then(response => { if (!response.ok) throw new Error(String(response.status)) })
        .then(() => mutate())
        .catch(() => notLinked(t('githubLinkFailed')))
    })
  }, [mutate, stopChecks, t])
  // In the browser, after a link from the app: the token in the URL, and what it says here.
  const [browserIntent, setBrowserIntent] = useState<{ token: string; view: IntentView } | null>(null)

  useEffect(() => {
    if (!userId) return
    const url = new URL(window.location.href)
    const token = url.searchParams.get('intent')
    const failed = url.searchParams.get('github') === 'link-failed'
    if (!failed && !token) return
    const reason = url.searchParams.get('reason')
    // 关联 GitHub in the header is the retry; the message says what happened.
    // A browser signed in as another account: the intent says which two (below).
    if (failed && reason !== 'browser-account') setGithubLinkError(reason === 'cancelled' ? t('githubLinkCancelled') : reason === 'account' ? t('githubLinkAccountChanged') : reason === 'expired' ? t('githubLinkExpired') : t('githubLinkFailed'))
    if (token && INTENT_TOKEN.test(token)) void readIntent(token).then(view => setBrowserIntent({ token, view })).catch(() => setGithubLinkError(t('githubLinkFailed')))
    for (const key of ['github', 'reason', 'intent']) url.searchParams.delete(key)
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [t, userId])


  async function linkGitHub(token = linking) {
    setGithubLinking(true); setGithubLinkError('')
    try {
      // The authorization has to finish in a real browser: the desktop hands it
      // the GitHub start itself, with a one-time token naming this account.
      // A desktop that takes the return on its loopback (RFC 8252) links this
      // account whatever the browser is signed in as, and confirms it with a
      // verifier only it holds once the return reaches this computer. An older
      // one needs the browser signed in as this account, and otherwise says so.
      const bridge = bridgeFromWindow(window as MikkaWindow)
      if (bridge && typeof bridge.app.openExternal !== 'function') { setGithubLinkError(t('browserUpdateRequired')); return }
      if (bridge) {
        let loopback: { returnTo: string; returnState: string; challenge: string } | undefined
        if (typeof bridge.app.prepareReturn === 'function') {
          const verifier = randomKey(), returnState = randomKey()
          loopback = { returnTo: await bridge.app.prepareReturn(returnState), returnState, challenge: await s256(verifier) }
          pendingReturn.current = { returnState, verifier, token: '' }
          token = null
        }
        if (!token) {
          const response = await fetch(INTENT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(loopback ? { loopback } : {}) })
          if (!response.ok) throw new Error(String(response.status))
          token = (await response.json() as { token: string }).token
          if (pendingReturn.current) pendingReturn.current.token = token
        }
        await openPathInBrowser(`${CONNECT_PATH}?intent=${encodeURIComponent(token)}`)
        setLinking(token); setBrowserAccount(null)
        returns.arm(LINK_WINDOW_MS)
        return
      }
      // A plugin connection, not a sign-in link: it never touches the login identity.
      window.location.assign(CONNECT_PATH)
    } catch {
      setGithubLinkError(t('githubLinkFailed'))
    } finally {
      setGithubLinking(false)
    }
  }

  async function disconnectGitHub() {
    setGithubLinking(true); setGithubLinkError('')
    try {
      const response = await fetch(withBasePath('/api/integrations/github'), { method: 'DELETE' })
      if (!response.ok) throw new Error(String(response.status))
      await mutate()
      toast.success(t('disconnected', { name: t('github') }))
    } catch {
      setGithubLinkError(t('githubDisconnectFailed'))
    } finally {
      setConfirming(false)
      setGithubLinking(false)
    }
  }

  const connected = Boolean(githubState?.connected)
  // Linked: the returns stop and the page shows the connection at once.
  const stopReturns = returns.stop
  useEffect(() => { if (connected && linking) { stopReturns(); setLinking(null); setBrowserAccount(null) } }, [connected, linking, stopReturns])

  /** The browser is signed in as another account: sign out here and back in as the app's, then go on with the same link. */
  async function switchAccount(token: string) {
    await endSession().catch(() => {})
    window.location.assign(withBasePath(`/sign-in?next=${encodeURIComponent(`/?section=plugins&app=github&intent=${token}`)}`))
  }
  const browserView = browserIntent?.view
  // In the browser during the app's link, the page's own 关联 GitHub would link this browser's account: the link's own buttons take its place.
  const canLink = !connected && Boolean(githubState?.configured || githubReconnect) && !(browserIntent && (browserIntent.view.state === 'otherAccount' || browserIntent.view.state === 'waiting'))
  const status = githubLoading ? null : !userId ? t('githubSignInRequired') : githubState && !githubState.configured ? t('githubNotConfigured') : null
  const login = githubState?.source === 'cloud' ? t('githubCloudConnection') : githubState?.login ? t('githubLogin', { login: githubState.login }) : t('github')
  const errors = [githubError, githubLinkError, browserView?.state === 'expired' ? t('githubLinkExpired') : ''].filter(Boolean)
  const writes = ABILITIES.write.map(id => ({ slug: id, name: t(`githubTool.${id}`), description: '' }))
  const reads = ABILITIES.read.map(id => ({ slug: id, name: t(`githubTool.${id}`), description: '' }))

  return {
    userId, email, githubState, githubLoading, githubLinking, linking, browserAccount, browserIntent, browserView, connected, canLink, status, login, errors, writes, reads,
    linkGitHub, disconnectGitHub, switchAccount, checkOnReturn,
    confirming, setConfirming, browsing, setBrowsing, clearLinkError: () => setGithubLinkError(''),
    /** Where 继续关联 goes in the browser, once it is signed in as the app's account. */
    continueHref: browserIntent ? `${CONNECT_PATH}?intent=${encodeURIComponent(browserIntent.token)}` : null,
  }
}

/** GitHub's page as the open-source UI draws it. */
function ViewerGitHubSettings(viewer: { userId: string | undefined; email: string; isPending: boolean }) {
  const t = useTranslations('Settings.integrations')
  const common = useTranslations('Common')
  const { userId, email, githubState, githubLoading, githubLinking, linking, browserAccount, browserIntent, browserView, connected, canLink, status, login, errors, writes, reads,
    linkGitHub, disconnectGitHub, switchAccount, checkOnReturn, confirming, setConfirming, browsing, setBrowsing, clearLinkError } = useGitHubPlugin(viewer)
  return <div className="flex flex-col gap-8">
    <header className="flex flex-wrap items-center gap-4">
      <AppTile app="github" size="xl" />
      <h2 className="min-w-0 flex-1 text-xl font-semibold">{t('github')}</h2>
      {githubLoading ? <span role="status" className="sr-only">{t('githubLoading')}</span>
        : canLink ? <span className="flex items-center gap-3">
          {linking && <span role="status" className="text-xs text-muted-foreground">{t('githubLinkWaiting')}</span>}
          <Button type="button" disabled={githubLinking} onClick={() => void linkGitHub()}>{githubLinking ? t('working') : t('githubLink')}</Button>
        </span>
        : status && <span className="text-xs text-muted-foreground">{status}</span>}
    </header>
    {errors.map(message => <Alert key={message} variant="destructive" className="border-transparent bg-destructive/10"><AlertTitle>{message}</AlertTitle></Alert>)}
    {/* The app: its browser is signed in as another account, so nothing was linked. The browser page offers the switch. */}
    {!connected && linking && browserAccount && <Alert role="status" className={NOTICE}>
      <TriangleAlert aria-hidden="true" className="text-warning-foreground" />
      <AlertTitle>{t('githubLinkOtherAccount', { browser: browserAccount, app: email })}</AlertTitle>
      <AlertDescription>{t('githubLinkUpdateHint')}</AlertDescription>
      <AlertAction><Button type="button" variant="secondary" size="sm" disabled={githubLinking} onClick={() => void linkGitHub(linking)}>{t('githubOpenBrowser')}</Button></AlertAction>
    </Alert>}
    {/* The browser: signed in as another account than the app that started the link. */}
    {!connected && browserIntent && browserView?.state === 'otherAccount' && <Alert role="status" className={NOTICE}>
      <TriangleAlert aria-hidden="true" className="text-warning-foreground" />
      <AlertTitle>{t('githubLinkOtherAccount', { browser: browserView.browserAccount, app: browserView.appAccount })}</AlertTitle>
      <AlertDescription>{t('githubLinkUpdateHint')}</AlertDescription>
      <AlertAction><Button type="button" variant="secondary" size="sm" onClick={() => void switchAccount(browserIntent.token)}>{t('githubSwitchAccount')}</Button></AlertAction>
    </Alert>}
    {/* The browser, now signed in as the app's account: the same link goes on. */}
    {!connected && browserIntent && browserView?.state === 'waiting' && <Alert className="border-transparent bg-muted">
      <AlertTitle>{t('githubLinkReady')}</AlertTitle>
      <AlertAction><Button type="button" size="sm" onClick={() => window.location.assign(`${CONNECT_PATH}?intent=${encodeURIComponent(browserIntent.token)}`)}>{t('githubContinueLink')}</Button></AlertAction>
    </Alert>}

    <p className="max-w-prose text-sm text-muted-foreground">{t('githubDescription')}</p>

    {userId && <GitHubAppSettings userId={userId} />}

    {connected && githubState && <PageSection id="github-connection-heading" title={t('githubConnectionHeading')}><SettingsSection>
      <div className="flex items-center gap-3 py-3 pr-4 pl-5">
        <AppTile app="github" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{login}</span>
        {githubState.source === 'cloud'
          ? <Button variant="secondary" size="sm" nativeButton={false} render={<a href={withBasePath(settingsHref('account'))} />}>{t('githubManageCloud')}</Button>
          : <Button type="button" variant="secondary" size="sm" disabled={githubLinking} onClick={() => { clearLinkError(); setConfirming(true) }}>{t('githubDisconnect')}</Button>}
      </div>
    </SettingsSection></PageSection>}

    {connected && githubState && <PageSection id="github-repositories-heading" title={t('githubRepositoryAccess')}><SettingsSection>
      <div className="relative flex items-center gap-3 py-3 pr-4 pl-5 transition-colors has-[[data-repositories]:hover]:bg-muted/50">
        {githubState.installed
          // The whole row opens the list (its hover covers the row); the GitHub link sits above it.
          ? <Button type="button" variant="ghost" data-repositories onClick={() => setBrowsing(true)} className="h-auto min-w-0 flex-1 justify-start truncate rounded-none border-0 p-0 text-sm font-medium after:absolute after:inset-0 hover:bg-transparent focus-visible:ring-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/40 focus-visible:after:ring-inset">{t('githubRepositories', { count: githubState.repositories.length })}</Button>
          : <span className="min-w-0 flex-1 truncate text-sm font-medium">{t('githubNotAuthorized')}</span>}
        <Button variant="ghost" size="sm" nativeButton={false} role="link" className="relative z-10 shrink-0 text-muted-foreground" render={<a href={INSTALL_URL} target="_blank" rel="noopener noreferrer" onClick={checkOnReturn} />}>
          {githubState.installed ? t('githubManage') : t('githubAuthorize')}<ArrowUpRight data-icon="inline-end" aria-hidden="true" />
        </Button>
        {githubState.installed && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      </div>
    </SettingsSection></PageSection>}

    <PageSection id="github-abilities-heading" title={t('githubAbilitiesHeading')} summary={t('githubAbilitiesSummary', { count: writes.length + reads.length, write: writes.length, read: reads.length })}>
      <ToolGroup label={t('writeTools', { count: writes.length })} tools={writes} uniformRows />
      <ToolGroup label={t('readTools', { count: reads.length })} tools={reads} uniformRows />
    </PageSection>

    {userId && githubState && <RepositoriesDialog open={browsing} onOpenChange={setBrowsing} repositories={githubState.repositories} userId={userId} />}

    <AlertDialog open={confirming} onOpenChange={open => { if (!open && !githubLinking) setConfirming(false) }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('disconnectTitle', { name: login })}</AlertDialogTitle>
          <AlertDialogDescription>{t('disconnectConsequence', { name: t('github') })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="secondary" disabled={githubLinking}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={githubLinking} onClick={() => void disconnectGitHub()}>{githubLinking ? t('working') : t('githubDisconnect')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

/** 已授权的仓库: search, open GitHub or configure the owner's verification command. */
export function RepositoriesDialog({ open, onOpenChange, repositories, userId }: { open: boolean; onOpenChange: (open: boolean) => void; repositories: GitHubRepository[]; userId: string }) {
  const t = useTranslations('Settings.integrations')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<GitHubRepository | null>(null)
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? repositories.filter(repository => repository.fullName.toLowerCase().includes(needle)) : repositories
  }, [query, repositories])
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) { setQuery(''); setEditing(null) } }}>
    <DialogContent className="flex max-h-[min(36rem,85dvh)] flex-col gap-4">
      <DialogHeader><DialogTitle className="pr-6 break-words">{editing?.fullName ?? t('githubRepositoriesDialog')}</DialogTitle></DialogHeader>
      {editing ? <RepositoryVerificationForm key={editing.fullName} repository={editing.fullName} userId={userId} onBack={() => setEditing(null)} /> : <>
      <SearchInput aria-label={t('githubRepositorySearch')} placeholder={t('githubRepositorySearch')} value={query} onChange={event => setQuery(event.target.value)} />
      <ul aria-label={t('githubRepositoryList')} className="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto">
        {shown.map(repository => <li key={repository.id} className="flex items-center gap-2">
          <a href={repository.htmlUrl} target="_blank" rel="noopener noreferrer" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-muted/50">
            <span className="min-w-0 truncate">{repository.fullName}</span>
            {repository.private && <Badge variant="secondary">{t('githubPrivate')}</Badge>}
          </a>
          <Button type="button" variant="ghost" size="sm" aria-label={t('githubVerificationFor', { repository: repository.fullName })} onClick={() => setEditing(repository)}>{t('githubVerification')}</Button>
        </li>)}
      </ul>
      </>}
    </DialogContent>
  </Dialog>
}

type RepositoryVerification = { viewerId: string; repository: string; verifyCommand: string | null }
function verificationResult(userId: string, repository: string, value: Partial<RepositoryVerification>): RepositoryVerification {
  if (value.viewerId !== userId || value.repository?.toLowerCase() !== repository.toLowerCase() || (value.verifyCommand !== null && typeof value.verifyCommand !== 'string')) throw new Error('shape')
  return value as RepositoryVerification
}
async function fetchVerification([, userId, repository]: readonly [string, string, string]) {
  const response = await fetch(`${VERIFICATION_PATH}?${new URLSearchParams({ repository })}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(String(response.status))
  return verificationResult(userId, repository, await response.json())
}

/** One repository's verification command: read, edit and save (the owner's only). Shared with UI layers. */
export function useRepositoryVerification({ repository, userId, onSaved }: { repository: string; userId: string; onSaved: () => void }) {
  const t = useTranslations('Settings.integrations')
  const { data, error, mutate } = useSWR([VERIFICATION_PATH, userId, repository] as const, fetchVerification, { revalidateOnFocus: false, shouldRetryOnError: false })
  const [command, setCommand] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const active = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])

  async function save() {
    if (!data || saving) return
    setSaving(true); setSaveError(false)
    try {
      const response = await fetch(VERIFICATION_PATH, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository, verifyCommand: (command ?? data.verifyCommand ?? '').trim() || null }),
      })
      if (!response.ok) throw new Error(String(response.status))
      await mutate(verificationResult(userId, repository, await response.json()), { revalidate: false })
      if (active.current) {
        toast.success(t('githubVerificationSaved'))
        onSaved()
      }
    } catch { setSaveError(true) } finally { setSaving(false) }
  }
  return {
    data, error, retry: () => { void mutate() }, saving, saveError, save,
    value: command ?? data?.verifyCommand ?? '', setValue: (next: string) => { setCommand(next); setSaveError(false) },
  }
}

function RepositoryVerificationForm({ repository, userId, onBack }: { repository: string; userId: string; onBack: () => void }) {
  const t = useTranslations('Settings.integrations')
  const common = useTranslations('Common')
  const { data, error, retry, saving, saveError, save, value, setValue } = useRepositoryVerification({ repository, userId, onSaved: onBack })

  return <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save() }}>
    {error ? <InlineLoadError message={t('githubVerificationLoadFailed')} retryLabel={common('retry')} onRetry={retry} /> : <FieldGroup><Field>
      <FieldLabel htmlFor="github-verification-command">{t('githubVerification')}</FieldLabel>
      <Input id="github-verification-command" className="font-mono" value={value} placeholder={t('githubNotConfigured')} maxLength={2000} disabled={!data || saving} autoComplete="off" spellCheck={false} aria-invalid={saveError} aria-describedby={saveError ? 'github-verification-error' : undefined} onChange={event => setValue(event.target.value)} />
      {!data && <span role="status" className="sr-only">{common('loading')}</span>}
    </Field></FieldGroup>}
    {saveError && <FieldError id="github-verification-error">{t('githubVerificationSaveUnconfirmed')}</FieldError>}
    <DialogFooter>
      <Button type="button" variant="ghost" disabled={saving} onClick={onBack}>{common('cancel')}</Button>
      <Button type="submit" disabled={!data || Boolean(error) || saving}>{saving ? common('saving') : common('save')}</Button>
    </DialogFooter>
  </form>
}

/** One heading style for every section on this page, flush with the card edge below it. */
function PageSection({ id, title, summary, children }: { id: string; title: string; summary?: string; children: ReactNode }) {
  return <section aria-labelledby={id} className="flex flex-col gap-3">
    <div className="flex flex-col gap-0.5">
      <h2 id={id} className="text-sm font-medium">{title}</h2>
      {summary && <p className="text-xs text-muted-foreground">{summary}</p>}
    </div>
    {children}
  </section>
}
