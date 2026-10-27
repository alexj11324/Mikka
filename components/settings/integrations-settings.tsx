'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { authClient } from '@/lib/auth-client'

type Toolkit = 'gmail' | 'googlecalendar' | 'notion' | 'slack'
type Account = { id: string; toolkit: Toolkit; status: string }
type IntegrationState = { configured: boolean; callbackVerifierConfigured: boolean; webhookConfigured: boolean; accounts: Account[] }
type GitHubState = { viewerId: string; configured: boolean; connected: boolean; installed: boolean; repositories: { id: string; fullName: string; installationId: string; htmlUrl: string; private: boolean }[] }

const TOOLKITS: Toolkit[] = ['gmail', 'googlecalendar', 'notion', 'slack']
const integrationPath = withBasePath('/api/integrations/composio')

export function IntegrationsSettings({ showWebhookDetails = true }: { showWebhookDetails?: boolean }) {
  const { data: session, isPending } = authClient.useSession()
  const userId = !isPending ? session?.user.id : undefined
  return <ViewerIntegrationsSettings key={userId ?? 'unconfirmed'} showWebhookDetails={showWebhookDetails} userId={userId} isPending={isPending} />
}

function ViewerIntegrationsSettings({ showWebhookDetails, userId, isPending }: { showWebhookDetails: boolean; userId: string | undefined; isPending: boolean }) {
  const t = useTranslations('Settings.integrations')
  const [state, setState] = useState<IntegrationState | null>(null)
  const [pending, setPending] = useState<Toolkit | ''>('')
  const [error, setError] = useState('')
  const [callbackError, setCallbackError] = useState('')
  const [callbackSuccess, setCallbackSuccess] = useState('')
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
      const callbackURL = new URL(window.location.href)
      callbackURL.searchParams.delete('github')
      const errorURL = new URL(callbackURL)
      errorURL.searchParams.set('github', 'link-failed')
      const result = await authClient.linkSocial({ provider: 'github', callbackURL: callbackURL.href, errorCallbackURL: errorURL.href })
      if (result.error || !result.data?.url) throw new Error()
      window.location.assign(result.data.url)
    } catch {
      setGithubLinkError(t('githubLinkFailed'))
      setGithubLinking(false)
    }
  }

  const refresh = useCallback(async () => {
    setError('')
    try {
      const response = await fetch(integrationPath, { cache: 'no-store' })
      if (!response.ok) throw new Error()
      setState(await response.json() as IntegrationState)
    } catch {
      setError(t('loadFailed'))
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!userId) return
    const url = new URL(window.location.href)
    const result = url.searchParams.get('composio')
    if (!result) return
    if (result === 'connected') setCallbackSuccess(t('connectionCompleted'))
    if (result === 'callback-failed') setCallbackError(t('callbackVerificationFailed'))
    url.searchParams.delete('composio')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [t, userId])

  async function connect(toolkit: Toolkit) {
    setPending(toolkit); setError('')
    try {
      const response = await fetch(integrationPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolkit }) })
      const result = await response.json()
      if (!response.ok || typeof result.redirectUrl !== 'string') throw new Error()
      const redirectURL = new URL(result.redirectUrl)
      if (redirectURL.protocol !== 'https:' || redirectURL.hostname !== 'connect.composio.dev') throw new Error()
      window.location.assign(redirectURL.href)
    } catch {
      setError(t('connectFailed'))
      setPending('')
    }
  }

  async function disconnect(accountId: string) {
    setPending(state?.accounts.find(account => account.id === accountId)?.toolkit ?? '')
    setError('')
    try {
      const response = await fetch(integrationPath, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }) })
      if (!response.ok) throw new Error()
      await refresh()
    } catch {
      setError(t('disconnectFailed'))
    } finally {
      setPending('')
    }
  }

  return <div className="flex flex-col gap-8">
    <SettingsSection id="connected-apps-heading" title={t('heading')}>
      <SettingRow title={t('github')} description={isPending || githubLoading ? t('githubLoading') : !userId ? t('githubSignInRequired') : !githubState ? undefined : !githubState.configured ? t('githubNotConfigured') : !githubState.connected ? t('githubAccountRequired') : !githubState.installed ? t('githubNotAuthorized') : t('githubRepositories', { count: githubState.repositories.length })}>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {(githubState?.configured || githubReconnect) && (githubState?.connected ? <Button variant="outline" size="sm" nativeButton={false} render={<a href="https://github.com/apps/mikka-github/installations/new" target="_blank" rel="noopener noreferrer" />}>
              {githubState.installed ? t('githubManage') : t('githubAuthorize')}
            </Button> : <Button type="button" variant="outline" size="sm" disabled={githubLinking} onClick={() => void linkGitHub()}>
              {githubLinking ? t('working') : t('githubLink')}
            </Button>)}
            <Button type="button" variant="outline" size="sm" disabled={!userId || githubLoading || githubLinking} onClick={() => void refreshGitHub()}>{t('githubRefresh')}</Button>
          </div>
          {githubState?.configured && githubState.connected && githubState.installed && githubState.repositories.length > 0 && <ScrollArea className="h-32 w-64 max-w-full">
            <ul aria-label={t('githubRepositoryList')} className="flex flex-col gap-1 pr-3 text-xs text-muted-foreground">
              {githubState.repositories.map(repository => <li key={repository.id} className="break-all">{repository.fullName}</li>)}
            </ul>
          </ScrollArea>}
          {githubError && <p role="alert" className="text-sm text-destructive">{githubError}</p>}
          {githubLinkError && <p role="alert" className="text-sm text-destructive">{githubLinkError}</p>}
        </div>
      </SettingRow>
      {TOOLKITS.map(toolkit => {
        const accounts = state?.accounts.filter(item => item.toolkit === toolkit) ?? []
        const title = t(toolkit)
        const description = t(`${toolkit}Description`)
        return <SettingRow key={toolkit} title={title} description={description}>
          <div className="flex flex-col items-end gap-2">
            {accounts.map(account => <div key={account.id} className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{account.status === 'ACTIVE' ? t('connected') : t('connectionInactive')}</span>
              <Button type="button" variant="outline" size="sm" disabled={!state?.configured || Boolean(pending)} onClick={() => void disconnect(account.id)}>
                {pending === toolkit ? t('working') : t('disconnect')}
              </Button>
            </div>)}
            <Button type="button" variant="outline" size="sm" disabled={!state?.configured || !state.callbackVerifierConfigured || Boolean(pending)} onClick={() => void connect(toolkit)}>
              {pending === toolkit ? t('working') : accounts.length ? t('connectAnother') : t('connect')}
            </Button>
          </div>
        </SettingRow>
      })}
    </SettingsSection>
    {!state && !error && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
    {state && !state.configured && <p role="status" className="text-sm text-muted-foreground">{t('composioNotConfigured')}</p>}
    {state?.configured && !state.callbackVerifierConfigured && <p role="status" className="text-sm text-muted-foreground">{t('callbackVerifierNotConfigured')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {showWebhookDetails && <SettingsSection id="composio-webhook-heading" title={t('webhookTitle')} description={t('webhookDescription')}>
      <SettingRow title={t('webhookPath')} description={state?.webhookConfigured ? t('webhookReady') : t('webhookSecretMissing')}>
        <code className="text-xs">{withBasePath('/api/webhooks/composio')}</code>
      </SettingRow>
    </SettingsSection>}
    {callbackSuccess && <p role="status" className="text-sm text-muted-foreground">{callbackSuccess}</p>}
    {callbackError && <p role="alert" className="text-sm text-destructive">{callbackError}</p>}
  </div>
}
