'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { authClient } from '@/lib/auth-client'
import { openSettingsInBrowser } from '@/lib/platform/open-settings'

type GitHubState = { viewerId: string; configured: boolean; connected: boolean; installed: boolean; repositories: { id: string; fullName: string; installationId: string; htmlUrl: string; private: boolean }[] }

/** GitHub's page on 插件: the account link, the app installation and the repositories it reaches. */
export function GitHubSettings() {
  const { data: session, isPending } = authClient.useSession()
  const userId = !isPending ? session?.user.id : undefined
  return <ViewerGitHubSettings key={userId ?? 'unconfirmed'} userId={userId} isPending={isPending} />
}

function ViewerGitHubSettings({ userId, isPending }: { userId: string | undefined; isPending: boolean }) {
  const t = useTranslations('Settings.integrations')
  const [githubState, setGithubState] = useState<GitHubState | null>(null)
  const [githubLoading, setGithubLoading] = useState(true)
  const [githubReconnect, setGithubReconnect] = useState(false)
  const [githubLinking, setGithubLinking] = useState(false)
  const [githubError, setGithubError] = useState('')
  const [githubLinkError, setGithubLinkError] = useState('')
  const githubRequest = useRef(0)

  const refreshGitHub = useCallback(async () => {
    const request = ++githubRequest.current
    setGithubLoading(true); setGithubState(null); setGithubReconnect(false); setGithubError('')
    if (!userId) { setGithubLoading(isPending); return }
    try {
      const response = await fetch(withBasePath('/api/integrations/github'), { cache: 'no-store' })
      const next = await response.json() as GitHubState & { error?: string }
      if (next.viewerId !== userId) throw new Error()
      if (!response.ok) {
        if (next.error === 'githubReconnectRequired') {
          if (request === githubRequest.current) { setGithubReconnect(true); setGithubError(t('githubReconnectRequired')) }
          return
        }
        throw new Error()
      }
      if (typeof next.configured !== 'boolean' || typeof next.connected !== 'boolean' || typeof next.installed !== 'boolean' || !Array.isArray(next.repositories) || next.repositories.some(repository => !repository || typeof repository.id !== 'string' || typeof repository.fullName !== 'string')) throw new Error()
      if (request === githubRequest.current) setGithubState(next)
    } catch {
      if (request === githubRequest.current) setGithubError(t('githubLoadFailed'))
    } finally {
      if (request === githubRequest.current) setGithubLoading(false)
    }
  }, [t, userId, isPending])

  useEffect(() => {
    void refreshGitHub()
    const onFocus = () => { void refreshGitHub() }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus); githubRequest.current++ }
  }, [refreshGitHub])

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
        {githubError && <p role="alert" className="text-sm text-destructive">{githubError}</p>}
        {githubLinkError && <p role="alert" className="text-sm text-destructive">{githubLinkError}</p>}
      </div>
    </SettingRow>
  </SettingsSection>
}
