'use client'

import { useTranslations } from 'next-intl'
import { Monitor, Moon, Sun } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { LocaleSetting } from '@/components/settings/locale-setting'
import { IssuePrefixSettings } from '@/components/settings/issue-prefix-settings'
import { ReplayOnboarding } from '@/components/settings/workspace-settings'
import { useAppearance, type AppTheme } from '@/hooks/settings/use-preferences-page'

/** 偏好设置: appearance and language, the task prefix, 重新播放引导. */
export function PreferencesSettings() {
  return <><AppearanceSection /><IssuePrefixSettings /><ReplayOnboarding /></>
}

function AppearanceSection() {
  const t = useTranslations('Settings.appearance')
  const { mounted, theme, setTheme } = useAppearance()
  return <SettingsSection id="appearance-heading" title={t('title')}>
    <SettingRow title={t('theme')}>
      <ToggleGroup aria-label={t('themeLabel')} variant="segment" spacing={0.5} disabled={!mounted} value={theme ? [theme] : []} onValueChange={values => { if (values[0]) setTheme(values[0] as AppTheme) }}>
        <ToggleGroupItem value="light" aria-label={t('light')}><Sun />{t('light')}</ToggleGroupItem>
        <ToggleGroupItem value="dark" aria-label={t('dark')}><Moon />{t('dark')}</ToggleGroupItem>
        <ToggleGroupItem value="system" aria-label={t('systemLabel')}><Monitor />{t('system')}</ToggleGroupItem>
      </ToggleGroup>
    </SettingRow>
    <SettingRow title={t('language')}><LocaleSetting /></SettingRow>
  </SettingsSection>
}
