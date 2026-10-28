'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ConnectedAppDetail, ConnectedAppsList, useConnectedApps } from '@/components/plugins/connected-apps'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'
import type { ComposioAppId } from '@/lib/composio-accounts'

/**
 * The Composio apps: a list, and a detail page per app with its accounts.
 * Pass `app` and `onAppChange` to control which detail page is open (the
 * plugins page hides its other sections while one is).
 */
export function IntegrationsSettings({ showWebhookDetails = true, rootLabel, app: controlledApp, onAppChange }: {
  showWebhookDetails?: boolean
  /** The breadcrumb's first step on a detail page. */
  rootLabel?: string
  app?: ComposioAppId | null
  onAppChange?: (app: ComposioAppId | null) => void
}) {
  const t = useTranslations('Settings.integrations')
  const apps = useConnectedApps()
  const [ownApp, setOwnApp] = useState<ComposioAppId | null>(null)
  const app = controlledApp === undefined ? ownApp : controlledApp
  const openApp = (next: ComposioAppId | null) => { setOwnApp(next); onAppChange?.(next) }
  const { state, error, notice } = apps

  return <div className="flex flex-col gap-8">
    {app
      ? <ConnectedAppDetail apps={apps} app={app} rootLabel={rootLabel ?? t('heading')} onBack={() => openApp(null)} />
      : <ConnectedAppsList apps={apps} title={t('heading')} onOpen={openApp} />}
    {!state && !error && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
    {state && !state.configured && <p role="status" className="text-sm text-muted-foreground">{t('composioNotConfigured')}</p>}
    {state?.configured && !state.callbackVerifierConfigured && <p role="status" className="text-sm text-muted-foreground">{t('callbackVerifierNotConfigured')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role={notice.tone} className={cn('text-sm', notice.tone === 'alert' ? 'text-destructive' : 'text-muted-foreground')}>{notice.text}</p>}
    {showWebhookDetails && !app && <SettingsSection id="composio-webhook-heading" title={t('webhookTitle')} description={t('webhookDescription')}>
      <SettingRow title={t('webhookPath')} description={state?.webhookConfigured ? t('webhookReady') : t('webhookSecretMissing')}>
        <code className="text-xs">{withBasePath('/api/webhooks/composio')}</code>
      </SettingRow>
    </SettingsSection>}
  </div>
}
