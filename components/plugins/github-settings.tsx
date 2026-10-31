'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { authClient } from '@/lib/auth-client'
import { openSettingsInBrowser } from '@/lib/platform/open-settings'
import { FieldError } from '@/components/ui/field'

type GitHubState = { viewerId: string; configured: boolean; connected: boolean; installed: boolean; repositories: { id: string; fullName: string; installationId: string; htmlUrl: string; private: boolean }[] }
/** A readable state, or an account link GitHub no longer accepts. */
type GitHubRead = { state: GitHubState; reconnect: false } | { state: null; reconnect: true }

const githubKey = (userId: string) => ['integrations:github', userId] as const

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

/** GitHub's page on 插件: the account link, the app installation and the repositories it reaches. */
export function GitHubSettings() {
  const { data: session, isPending } = authClient.useSession()
  const userId = !isPending ? session?.user.id : undefined
  return <ViewerGitHubSettings key={userId ?? 'unconfirmed'} userId={userId} isPending={isPending} />
}

function ViewerGitHubSettings({ userId, isPending }: { userId: string | undefined; isPending: boolean }) {
  const t = useTranslations('Settings.integrations')
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
      const handoff = await openSettingsInBrowser('integrations')
      if (handoff === 'desktop') return
      if (handoff === 'unsupported') { setGithubLinkError(t('browserUpdateRequired')); return }
      const callbackURL = new URL(window.location.href)
      callbackURL.searchParams.delete('github')
      const errorURL = new URL(callbackURL)
      errorURL.searchParams.set('github', 'link-failed')
      const result = await authClient.linkSocial({ provider: 'github', callbackURL: callbackURL.href, errorCallbackURL: errorURL.href })
      if (result.error || !result.data?.url) throw new Error()
      window.location.assign(result.data.url)
    } catch {
      setGithubLinkError(t('githubLinkFailed'))
    } finally {
      setGithubLinking(false)
    }
  }

  return <SettingsSection id="github-connection-heading">
    <SettingRow title={t('github')} description={isPending || githubLoading ? t('githubLoading') : !userId ? t('githubSignInRequired') : !githubState ? undefined : !githubState.configured ? t('githubNotConfigured') : !githubState.connected ? t('githubAccountRequired') : !githubState.installed ? t('githubNotAuthorized') : t('githubRepositories', { count: githubState.repositories.length })}>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        {(githubState?.configured || githubReconnect) && (githubState?.connected ? <Button variant="outline" size="sm" nativeButton={false} role="link" render={<a href="https://github.com/apps/mikka-github/installations/new" target="_blank" rel="noopener noreferrer" />}>
          {githubState.installed ? t('githubManage') : t('githubAuthorize')}
        </Button> : <Button type="button" variant="outline" size="sm" disabled={githubLinking} onClick={() => void linkGitHub()}>
          {githubLinking ? t('working') : t('githubLink')}
        </Button>)}
        {githubState?.configured && githubState.connected && githubState.installed && githubState.repositories.length > 0 && <ScrollArea className="h-32 w-64 max-w-full">
          <ul aria-label={t('githubRepositoryList')} className="flex flex-col gap-1 pr-3 text-xs text-muted-foreground">
            {githubState.repositories.map(repository => <li key={repository.id} className="break-all">{repository.fullName}</li>)}
          </ul>
        </ScrollArea>}
        {githubError && <FieldError>{githubError}</FieldError>}
        {githubLinkError && <FieldError>{githubLinkError}</FieldError>}
      </div>
    </SettingRow>
  </SettingsSection>
}
