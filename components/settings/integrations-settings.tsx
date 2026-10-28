'use client'

import { useTranslations } from 'next-intl'
import { ConnectedAppsList, ConnectedAppsStatus, useConnectedApps, usePluginHref } from '@/components/plugins/connected-apps'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'

/**
 * Settings › 连接: the Composio apps with their switches. Each app's page
 * (accounts, default, reconnect, disconnect) lives on the plugins page; the
 * rows link there.
 */
export function IntegrationsSettings({ showWebhookDetails = true }: { showWebhookDetails?: boolean }) {
  const t = useTranslations('Settings.integrations')
  const apps = useConnectedApps()
  const pluginHref = usePluginHref()

  return <div className="flex flex-col gap-8">
    <ConnectedAppsList apps={apps} title={t('heading')} appHref={pluginHref} />
    <ConnectedAppsStatus apps={apps} />
    {showWebhookDetails && <SettingsSection id="composio-webhook-heading" title={t('webhookTitle')} description={t('webhookDescription')}>
      <SettingRow title={t('webhookPath')} description={apps.state?.webhookConfigured ? t('webhookReady') : t('webhookSecretMissing')}>
        <code className="text-xs">{withBasePath('/api/webhooks/composio')}</code>
      </SettingRow>
    </SettingsSection>}
  </div>
}
