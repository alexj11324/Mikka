'use client'

import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { NOTIFICATION_SWITCHES, useNotificationSettings } from '@/hooks/settings/use-notification-settings'

/** D16: the notification settings the phone already has, on the web Settings page. */
export function NotificationSettings() {
  const t = useTranslations('Settings.notifications')
  const { data, error, reload, set, failed, retry } = useNotificationSettings()

  if (error) return <SettingsSaveError message={t('loadError')} retryLabel={t('retry')} onRetry={() => { void reload() }} />
  if (!data) return <SettingsLoading label={t('loading')} rows={6} />

  const switches = NOTIFICATION_SWITCHES.map(key => ({ key, title: t(key) }))

  return <div className="flex flex-col gap-6">
    {/* One group under the page title 通知: no group title repeating it (R-40). */}
    <SettingsSection>
      {switches.map(({ key, title }) => <SettingRow key={key} title={title}>
        <Switch checked={data[key]} aria-label={title} onCheckedChange={checked => { void set({ [key]: checked }) }} />
      </SettingRow>)}
      <SettingRow title={t('pushWhen')}>
        <ToggleGroup aria-label={t('pushWhen')} variant="segment" spacing={0.5} value={[data.pushWhen]} onValueChange={values => {
          const next = values[0]
          if (next === 'always' || next === 'away') void set({ pushWhen: next })
        }}>
          <ToggleGroupItem value="always" aria-label={t('always')}>{t('always')}</ToggleGroupItem>
          <ToggleGroupItem value="away" aria-label={t('away')}>{t('away')}</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
    </SettingsSection>
    {failed && <SettingsSaveError message={t('notSaved')} retryLabel={t('retry')} onRetry={retry} />}
  </div>
}
