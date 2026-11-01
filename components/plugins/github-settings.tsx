'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, Ellipsis } from 'lucide-react'
import { toast } from 'sonner'
import { AppTile, AppTools } from '@/components/plugins/connected-apps'
import { SettingsSection } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { FieldError } from '@/components/ui/field'
import { withBasePath } from '@/lib/base-path'
import { authClient } from '@/lib/auth-client'
import { openPathInBrowser } from '@/lib/platform/open-settings'
import type { AppTool } from '@/lib/plugins/app-detail'

type GitHubRepository = { id: string; fullName: string; installationId: string; htmlUrl: string; private: boolean }
type GitHubState = { viewerId: string; configured: boolean; connected: boolean; login?: string | null; installed: boolean; repositories: GitHubRepository[] }
/** A readable state, or an account link GitHub no longer accepts. */
type GitHubRead = { state: GitHubState; reconnect: false } | { state: null; reconnect: true }

const githubKey = (userId: string) => ['integrations:github', userId] as const
const CONNECT_PATH = withBasePath('/api/integrations/github/connect')
/** The Mikka GitHub App's page where a person picks which repositories it may reach. */
const INSTALL_URL = 'https://github.com/apps/mikka-github/installations/new'

/**
 * What an Agent can do through this plugin, from the code that does it: the run
 * token's permissions (lib/github/run-pull-request.ts: contents and
 * pull_requests write, checks and actions read) and the readbacks in
 * lib/github/user-access.ts. A new ability lands here with its code.
 */
const GITHUB_TOOLS = {
  write: ['push', 'pullRequest'],
  read: ['readCode', 'readPullRequest', 'readIssue', 'readChecks'],
} as const

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

/** GitHub's page on 插件: header and link, what the plugin does, its tools, the account and the repositories it reaches. */
export function GitHubSettings() {
  const { data: session, isPending } = authClient.useSession()
  const userId = !isPending ? session?.user.id : undefined
  return <ViewerGitHubSettings key={userId ?? 'unconfirmed'} userId={userId} isPending={isPending} />
}

function ViewerGitHubSettings({ userId, isPending }: { userId: string | undefined; isPending: boolean }) {
  const t = useTranslations('Settings.integrations')
  const common = useTranslations('Common')
  // Cached across visits: a revisit shows the last state at once and re-checks it behind.
  // Every mount and focus asks GitHub again (no deduping), like the PR badge.
  const { data, error, isLoading, mutate } = useSWR(userId ? githubKey(userId) : null, readGitHub, { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 0 })
  // Back from the browser, the cookie may belong to someone else: hide what was
  // shown until GitHub answers again.
  const [rechecking, setRechecking] = useState(false)
  const hidden = rechecking || Boolean(error)
  const githubState = hidden ? null : data?.state ?? null
  const githubReconnect = !hidden && Boolean(data?.reconnect)
  const githubLoading = isPending || isLoading || rechecking
  const githubError = error && !rechecking ? t('githubLoadFailed') : githubReconnect ? t('githubReconnectRequired') : ''
  const [githubLinking, setGithubLinking] = useState(false)
  const [githubLinkError, setGithubLinkError] = useState('')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!userId) return
    let current = true
    const onFocus = () => {
      setRechecking(true)
      void mutate().finally(() => { if (current) setRechecking(false) })
    }
    window.addEventListener('focus', onFocus)
    return () => { current = false; window.removeEventListener('focus', onFocus) }
  }, [userId, mutate])

  useEffect(() => {
    if (!userId) return
    const url = new URL(window.location.href)
    if (url.searchParams.get('github') !== 'link-failed') return
    setGithubLinkError(t('githubLinkFailed'))
    url.searchParams.delete('github')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [t, userId])

  async function linkGitHub() {
    setGithubLinking(true); setGithubLinkError('')
    try {
      // The authorization has to finish in a real browser: the desktop hands it
      // the GitHub start itself, which goes straight on to github.com.
      const handoff = await openPathInBrowser(CONNECT_PATH)
      if (handoff === 'desktop') return
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
      setConfirming(false)
      toast.success(t('disconnected', { name: t('github') }))
    } catch {
      setGithubLinkError(t('githubDisconnectFailed'))
      setConfirming(false)
    } finally {
      setGithubLinking(false)
    }
  }

  const tools: { write: AppTool[]; read: AppTool[] } = {
    write: GITHUB_TOOLS.write.map(id => ({ slug: id, name: t(`githubTool.${id}`), description: t(`githubTool.${id}Description`) })),
    read: GITHUB_TOOLS.read.map(id => ({ slug: id, name: t(`githubTool.${id}`), description: t(`githubTool.${id}Description`) })),
  }
  const connected = Boolean(githubState?.connected)
  const canLink = Boolean(githubState?.configured || githubReconnect) && !connected
  const status = githubLoading ? null : !userId ? t('githubSignInRequired') : githubState && !githubState.configured ? t('githubNotConfigured') : null
  const accountName = githubState?.login ? t('githubLogin', { login: githubState.login }) : t('github')

  return <div className="flex flex-col gap-8">
    <header className="flex flex-wrap items-center gap-4">
      <AppTile app="github" size="xl" />
      <h2 className="min-w-0 flex-1 text-xl font-semibold">{t('github')}</h2>
      {githubLoading ? <span role="status" className="text-sm text-muted-foreground">{t('githubLoading')}</span>
        : canLink ? <Button type="button" disabled={githubLinking} onClick={() => void linkGitHub()}>{githubLinking ? t('working') : t('githubLink')}</Button>
        : status && <span className="text-sm text-muted-foreground">{status}</span>}
    </header>
    {(githubError || githubLinkError) && <div className="flex flex-col gap-1">
      {githubError && <FieldError>{githubError}</FieldError>}
      {githubLinkError && <FieldError>{githubLinkError}</FieldError>}
    </div>}

    <p className="max-w-prose text-sm leading-6 text-muted-foreground">{t('githubDescription')}</p>

    {connected && githubState && <SettingsSection id="github-account-heading" title={t('accountsHeading')}>
      <div className="flex items-center gap-3 py-3 pr-3 pl-5">
        <AppTile app="github" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{accountName}</span>
          <span className="truncate text-xs text-muted-foreground">{githubState.installed ? t('githubRepositories', { count: githubState.repositories.length }) : t('githubNotAuthorized')}</span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('accountActions', { name: accountName })} disabled={githubLinking} />}><Ellipsis data-icon="inline-start" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" onClick={() => { setGithubLinkError(''); setConfirming(true) }}>{t('disconnect')}</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </SettingsSection>}

    <AppTools tools={tools} />

    {connected && githubState && <SettingsSection id="github-repositories-heading" title={t('githubRepositoriesHeading')} action={<Button variant="ghost" size="sm" nativeButton={false} role="link" render={<a href={INSTALL_URL} target="_blank" rel="noopener noreferrer" />}>
      {githubState.installed ? t('githubManage') : t('githubAuthorize')}<ArrowUpRight data-icon="inline-end" />
    </Button>}>
      {githubState.installed && githubState.repositories.length > 0 ? <ul aria-label={t('githubRepositoryList')} className="flex max-h-96 flex-col overflow-y-auto">
        {githubState.repositories.map(repository => <li key={repository.id} className="flex items-center gap-2 px-5 py-2.5 text-sm">
          <a href={repository.htmlUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:underline">{repository.fullName}</a>
          {repository.private && <Badge variant="secondary">{t('githubPrivate')}</Badge>}
        </li>)}
      </ul> : <div className="px-5 py-3 text-sm text-muted-foreground">{githubState.installed ? t('githubRepositories', { count: 0 }) : t('githubNotAuthorized')}</div>}
    </SettingsSection>}

    <AlertDialog open={confirming} onOpenChange={open => { if (!open && !githubLinking) setConfirming(false) }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('disconnectTitle', { name: accountName })}</AlertDialogTitle>
          <AlertDialogDescription>{t('disconnectConsequence', { name: t('github') })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="secondary" disabled={githubLinking}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={githubLinking} onClick={() => void disconnectGitHub()}>{githubLinking ? t('working') : t('disconnect')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
