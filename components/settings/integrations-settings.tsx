'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'

type Toolkit = 'notion' | 'slack'
type Account = { id: string; toolkit: Toolkit; status: string }
type IntegrationState = { configured: boolean; webhookConfigured: boolean; accounts: Account[] }

const TOOLKITS: Toolkit[] = ['notion', 'slack']
const integrationPath = withBasePath('/api/integrations/composio')

export function IntegrationsSettings() {
  const t = useTranslations('Settings.integrations')
  const [state, setState] = useState<IntegrationState | null>(null)
  const [pending, setPending] = useState<Toolkit | ''>('')
  const [error, setError] = useState('')

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
    <SettingsSection id="connected-apps-heading" title={t('heading')} description={t('description')}>
      {TOOLKITS.map(toolkit => {
        const account = state?.accounts.find(item => item.toolkit === toolkit && item.status === 'ACTIVE')
        const title = toolkit === 'notion' ? t('notion') : t('slack')
        const description = toolkit === 'notion' ? t('notionDescription') : t('slackDescription')
        return <SettingRow key={toolkit} title={title} description={description}>
          <div className="flex items-center gap-3">
            {account && <span className="text-xs text-muted-foreground">{t('connected')}</span>}
            <Button type="button" variant="outline" size="sm" disabled={!state?.configured || Boolean(pending)} onClick={() => account ? void disconnect(account.id) : void connect(toolkit)}>
              {pending === toolkit ? t('working') : account ? t('disconnect') : t('connect')}
            </Button>
          </div>
        </SettingRow>
      })}
    </SettingsSection>
    {!state && !error && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
    {state && !state.configured && <p role="status" className="text-sm text-muted-foreground">{t('composioNotConfigured')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <SettingsSection id="composio-webhook-heading" title={t('webhookTitle')} description={t('webhookDescription')}>
      <SettingRow title={t('webhookPath')} description={state?.webhookConfigured ? t('webhookReady') : t('webhookSecretMissing')}>
        <code className="text-xs">{withBasePath('/api/webhooks/composio')}</code>
      </SettingRow>
    </SettingsSection>
  </div>
}
