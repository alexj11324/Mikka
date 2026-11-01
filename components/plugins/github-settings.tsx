'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { AppTile, ToolGroup } from '@/components/plugins/connected-apps'
import { SettingsSection } from '@/components/settings/primitives'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SearchInput } from '@/components/ui/search-input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { withBasePath } from '@/lib/base-path'
import { authClient } from '@/lib/auth-client'
import { openPathInBrowser } from '@/lib/platform/open-settings'
import { useCheckOnReturn } from '@/lib/hooks/use-check-on-return'

type GitHubRepository = { id: string; fullName: string; installationId: string; htmlUrl: string; private: boolean }
type GitHubState = { viewerId: string; configured: boolean; connected: boolean; login?: string | null; installed: boolean; repositories: GitHubRepository[] }
/** A readable state, or an account link GitHub no longer accepts. */
type GitHubRead = { state: GitHubState; reconnect: false } | { state: null; reconnect: true }
type Decision = 'allow' | 'ask' | 'deny'
type Permissions = { push: Decision; pullRequest: Decision; version: string }
type WriteAbility = keyof Omit<Permissions, 'version'>

const githubKey = (userId: string) => ['integrations:github', userId] as const
const permissionsKey = (userId: string) => ['integrations:github:permissions', userId] as const
const CONNECT_PATH = withBasePath('/api/integrations/github/connect')
const PERMISSIONS_PATH = withBasePath('/api/integrations/github/permissions')
/** The Mikka GitHub App's page where a person picks which repositories it may reach. */
const INSTALL_URL = 'https://github.com/apps/mikka-github/installations/new'
const DECISIONS: readonly Decision[] = ['allow', 'ask', 'deny']

/**
 * What an Agent does through this plugin, from the code that does it. Writes:
 * the pushed branch, which the GitHub App's own access decides (contents:
 * write on the repository, lib/github/push-grant.ts; nothing to set here), and
 * the pull request (lib/github/run-pull-request.ts) with allow / ask / deny.
 * Reads run directly (R-77): cloning, and the readbacks in
 * lib/github/user-access.ts and the run token's checks/actions read.
 * A new ability lands here with its code.
 */
const ABILITIES = {
  write: [{ id: 'push', setting: 'push' }, { id: 'pullRequest', setting: 'pullRequest' }] as const,
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

const isDecision = (value: unknown): value is Decision => typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)
function readPermissions(userId: string, next: Partial<Permissions> & { viewerId?: unknown }): Permissions {
  if (next.viewerId !== userId || !isDecision(next.push) || !isDecision(next.pullRequest) || typeof next.version !== 'string') throw new Error('shape')
  return { push: next.push, pullRequest: next.pullRequest, version: next.version }
}
async function fetchPermissions([, userId]: ReturnType<typeof permissionsKey>): Promise<Permissions> {
  const response = await fetch(PERMISSIONS_PATH, { cache: 'no-store' })
  if (!response.ok) throw new Error(String(response.status))
  return readPermissions(userId, await response.json())
}

/** GitHub's page on 插件: header and link, what it does, the connection, repository access and its abilities. */
export function GitHubSettings() {
  const { data: session, isPending } = authClient.useSession()
  const userId = !isPending ? session?.user.id : undefined
  return <ViewerGitHubSettings key={userId ?? 'unconfirmed'} userId={userId} isPending={isPending} />
}

function ViewerGitHubSettings({ userId, isPending }: { userId: string | undefined; isPending: boolean }) {
  const t = useTranslations('Settings.integrations')
  const common = useTranslations('Common')
  // Cached across visits: a revisit shows the last state at once and re-checks it behind.
  // Every mount asks GitHub again, exactly once. Focus never does: what is shown
  // stays until the person's own action or a finished hand-off reads again.
  // SWR's own mount re-check is off: with a cached answer it waits a frame and
  // is deduplicated against the read before it, whose entry clears on a 0 ms
  // timer, so a quick revisit could skip the read. A mount effect reads instead.
  const { data, error, mutate } = useSWR(userId ? githubKey(userId) : null, readGitHub, { revalidateOnMount: false, revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 0 })
  useEffect(() => { if (userId) void mutate() }, [userId, mutate])
  const permissions = useSWR(userId ? permissionsKey(userId) : null, fetchPermissions, { revalidateOnFocus: false, shouldRetryOnError: false })
  const githubState = error ? null : data?.state ?? null
  const githubReconnect = !error && Boolean(data?.reconnect)
  const githubLoading = isPending || (Boolean(userId) && !data && !error)
  const githubError = error ? t('githubLoadFailed') : githubReconnect ? t('githubReconnectRequired') : ''
  const [githubLinking, setGithubLinking] = useState(false)
  const [githubLinkError, setGithubLinkError] = useState('')
  const [permissionError, setPermissionError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  // The link or installation finishes in another window: read once on the way back.
  const checkOnReturn = useCheckOnReturn(() => { void mutate() })

  useEffect(() => {
    if (!userId) return
    const url = new URL(window.location.href)
    if (url.searchParams.get('github') !== 'link-failed') return
    const reason = url.searchParams.get('reason')
    // 关联 GitHub in the header is the retry; the message says what happened.
    setGithubLinkError(reason === 'cancelled' ? t('githubLinkCancelled') : reason === 'account' ? t('githubLinkAccountChanged') : t('githubLinkFailed'))
    url.searchParams.delete('github')
    url.searchParams.delete('reason')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [t, userId])

  async function linkGitHub() {
    setGithubLinking(true); setGithubLinkError('')
    try {
      // The authorization has to finish in a real browser: the desktop hands it
      // the GitHub start itself, which goes straight on to github.com.
      const handoff = await openPathInBrowser(CONNECT_PATH)
      if (handoff === 'desktop') { checkOnReturn(); return }
      if (handoff === 'unsupported') { setGithubLinkError(t('browserUpdateRequired')); return }
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

  /** The segment moves at once; it goes back if the server refuses or the setting changed elsewhere. */
  async function setPermission(ability: WriteAbility, value: Decision) {
    const current = permissions.data
    if (!userId || !current || current[ability] === value) return
    setPermissionError('')
    await permissions.mutate(async () => {
      const response = await fetch(PERMISSIONS_PATH, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: current.version, [ability]: value }) })
      if (!response.ok) throw new Error(String(response.status))
      return readPermissions(userId, await response.json())
    }, { optimisticData: { ...current, [ability]: value }, rollbackOnError: true, revalidate: false }).catch(() => {
      setPermissionError(t('githubPermissionFailed'))
      void permissions.mutate()
    })
  }

  const connected = Boolean(githubState?.connected)
  const canLink = !connected && Boolean(githubState?.configured || githubReconnect)
  const status = githubLoading ? null : !userId ? t('githubSignInRequired') : githubState && !githubState.configured ? t('githubNotConfigured') : null
  const login = githubState?.login ? t('githubLogin', { login: githubState.login }) : t('github')
  const errors = [githubError, githubLinkError, permissionError].filter(Boolean)
  // 推送分支 is whatever the GitHub App was granted on GitHub: shown, not set (decision 2026-11-01-1215).
  const control = (setting: WriteAbility, name: string) => setting === 'push'
    ? <span className="text-xs text-muted-foreground">{t('githubPushByApp')}</span>
    : <ToggleGroup aria-label={name} variant="segment" size="sm" spacing={0.5} disabled={!permissions.data} value={permissions.data ? [permissions.data[setting]] : []} onValueChange={values => {
      const next = values[0]
      if (isDecision(next) && next !== permissions.data![setting]) void setPermission(setting, next)
    }}>
      {DECISIONS.map(value => <ToggleGroupItem key={value} value={value}>{t(`githubPermission.${value}`)}</ToggleGroupItem>)}
    </ToggleGroup>
  const writes = ABILITIES.write.map(({ id, setting }) => ({ slug: setting, name: t(`githubTool.${id}`), description: '' }))
  const reads = ABILITIES.read.map(id => ({ slug: id, name: t(`githubTool.${id}`), description: '' }))

  return <div className="flex flex-col gap-8">
    <header className="flex flex-wrap items-center gap-4">
      <AppTile app="github" size="xl" />
      <h2 className="min-w-0 flex-1 text-xl font-semibold">{t('github')}</h2>
      {githubLoading ? <span role="status" className="sr-only">{t('githubLoading')}</span>
        : canLink ? <Button type="button" disabled={githubLinking} onClick={() => void linkGitHub()}>{githubLinking ? t('working') : t('githubLink')}</Button>
        : status && <span className="text-xs text-muted-foreground">{status}</span>}
    </header>
    {errors.map(message => <Alert key={message} variant="destructive" className="border-transparent bg-destructive/10"><AlertTitle>{message}</AlertTitle></Alert>)}

    <p className="max-w-prose text-sm text-muted-foreground">{t('githubDescription')}</p>

    {connected && githubState && <PageSection id="github-connection-heading" title={t('githubConnectionHeading')}><SettingsSection>
      <div className="flex items-center gap-3 py-3 pr-4 pl-5">
        <AppTile app="github" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{login}</span>
        <Button type="button" variant="secondary" size="sm" disabled={githubLinking} onClick={() => { setGithubLinkError(''); setConfirming(true) }}>{t('githubDisconnect')}</Button>
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
      {/* Rows keep one height in both groups, with or without a control. */}
      <ToolGroup label={t('writeTools', { count: writes.length })} tools={writes} uniformRows control={tool => control(tool.slug as WriteAbility, tool.name)} />
      <ToolGroup label={t('readTools', { count: reads.length })} tools={reads} uniformRows />
    </PageSection>

    {githubState && <RepositoriesDialog open={browsing} onOpenChange={setBrowsing} repositories={githubState.repositories} />}

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

/** 已授权的仓库: search by name; each opens on GitHub. The card never lists them. */
function RepositoriesDialog({ open, onOpenChange, repositories }: { open: boolean; onOpenChange: (open: boolean) => void; repositories: GitHubRepository[] }) {
  const t = useTranslations('Settings.integrations')
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? repositories.filter(repository => repository.fullName.toLowerCase().includes(needle)) : repositories
  }, [query, repositories])
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) setQuery('') }}>
    <DialogContent className="flex max-h-[min(36rem,85dvh)] flex-col gap-4">
      <DialogHeader><DialogTitle>{t('githubRepositoriesDialog')}</DialogTitle></DialogHeader>
      <SearchInput aria-label={t('githubRepositorySearch')} placeholder={t('githubRepositorySearch')} value={query} onChange={event => setQuery(event.target.value)} />
      <ul aria-label={t('githubRepositoryList')} className="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto">
        {shown.map(repository => <li key={repository.id}>
          <a href={repository.htmlUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-muted/50">
            <span className="min-w-0 truncate">{repository.fullName}</span>
            {repository.private && <Badge variant="secondary">{t('githubPrivate')}</Badge>}
          </a>
        </li>)}
      </ul>
    </DialogContent>
  </Dialog>
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
