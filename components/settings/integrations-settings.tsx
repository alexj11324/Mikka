'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { getPathname } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { Google } from '@/components/ui/svgs/google'

type Toolkit = 'gmail' | 'googlecalendar' | 'notion' | 'slack'
type Account = { id: string; toolkit: Toolkit; status: string }
type IntegrationState = { configured: boolean; callbackVerifierConfigured: boolean; webhookConfigured: boolean; accounts: Account[] }

const TOOLKITS: Toolkit[] = ['gmail', 'googlecalendar', 'notion', 'slack']
const integrationPath = withBasePath('/api/integrations/composio')

export function IntegrationsSettings({ googleEnabled, showWebhookDetails = true }: { googleEnabled: boolean; showWebhookDetails?: boolean }) {
  const locale = useLocale()
  const t = useTranslations('Settings.integrations')
  const [state, setState] = useState<IntegrationState | null>(null)
  const [pending, setPending] = useState<Toolkit | ''>('')
  const [error, setError] = useState('')
  const [googleLinked, setGoogleLinked] = useState<boolean | null>(null)
  const [googlePending, setGooglePending] = useState(false)
  const [googleError, setGoogleError] = useState('')
  const [callbackError, setCallbackError] = useState('')
  const [callbackSuccess, setCallbackSuccess] = useState('')
  const [googleSuccess, setGoogleSuccess] = useState('')

  useEffect(() => {
    if (!googleEnabled) { setGoogleLinked(false); return }
    let current = true
    void authClient.listAccounts().then(({ data, error: resultError }) => {
      if (!current) return
      if (resultError) {
        setGoogleError(t('googleStatusFailed'))
        setGoogleLinked(false)
      } else {
        setGoogleError('')
        setGoogleLinked(data?.some(account => account.providerId === 'google') ?? false)
      }
    }).catch(() => {
      if (!current) return
      setGoogleError(t('googleStatusFailed'))
      setGoogleLinked(false)
    })
    return () => { current = false }
  }, [googleEnabled, t])

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
    const url = new URL(window.location.href)
    const googleResult = url.searchParams.get('google')
    if (googleResult === 'linked') {
      setGoogleLinked(true)
      setGoogleError('')
      setGoogleSuccess(t('googleLinkSuccess'))
    }
    if (googleResult === 'failed') setGoogleError(t('googleLinkFailed'))
    url.searchParams.delete('google')
    const result = url.searchParams.get('composio')
    if (!result) {
      if (googleResult) window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
      return
    }
    if (result === 'connected') setCallbackSuccess(t('connectionCompleted'))
    if (result === 'callback-failed') setCallbackError(t('callbackVerificationFailed'))
    url.searchParams.delete('composio')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [t])

  async function linkGoogle() {
    setGooglePending(true); setGoogleError(''); setGoogleSuccess('')
    try {
      const callbackURL = new URL(withBasePath('/api/integrations/google/callback'), window.location.origin)
      callbackURL.searchParams.set('locale', locale)
      const settingsURL = new URL(withBasePath(`${getPathname({ locale, href: '/' })}?settings=integrations&google=failed`), window.location.origin)
      const result = await authClient.linkSocial({ provider: 'google', callbackURL: callbackURL.href, errorCallbackURL: settingsURL.href })
      if (result.error) throw new Error()
      if (result.data?.url) window.location.assign(result.data.url)
    } catch {
      setGoogleError(t('googleLinkFailed'))
      setGooglePending(false)
    }
  }

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
    <SettingsSection id="google-sign-in-heading" title={t('googleSignInTitle')} description={t('googleSignInDescription')}>
      <SettingRow title={t('googleSignIn')} description={googleLinked ? t('googleLinkedDescription') : t('googleLinkDescription')}>
        <div className="flex items-center gap-3">
          {googleLinked && <span className="text-xs text-muted-foreground">{t('googleLinked')}</span>}
          {!googleLinked && <Button type="button" variant="outline" size="sm" disabled={!googleEnabled || googleLinked === null || googlePending} onClick={() => void linkGoogle()}>
            <Google className="size-4" />{googlePending ? t('googleLinking') : t('linkGoogle')}
          </Button>}
        </div>
      </SettingRow>
      {!googleEnabled && <p role="status" className="text-sm text-muted-foreground">{t('googleNotConfigured')}</p>}
      {googleSuccess && <p role="status" className="text-sm text-muted-foreground">{googleSuccess}</p>}
      {googleError && <p role="alert" className="text-sm text-destructive">{googleError}</p>}
    </SettingsSection>
    <SettingsSection id="connected-apps-heading" title={t('heading')} description={t('description')}>
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
