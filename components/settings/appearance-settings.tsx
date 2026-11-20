'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { Monitor, Moon, Sun } from '@/components/icons'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { useAppearance, type AppTheme } from '@/hooks/settings/use-preferences-page'

/** 外观: light, dark, or the system theme. The read and write stay on the existing preferences hook. */
export function AppearanceSettings() {
  const t = useTranslations('Settings.appearance')
  const { mounted, theme, setTheme } = useAppearance()
  return <SettingsSection id="appearance-heading">
    <SettingRow title={t('theme')}>
      <ToggleGroup aria-label={t('themeLabel')} variant="segment" spacing={0.5} disabled={!mounted} value={theme ? [theme] : []} onValueChange={values => { if (values[0]) setTheme(values[0] as AppTheme) }}>
        <ToggleGroupItem value="light" aria-label={t('light')}><Sun />{t('light')}</ToggleGroupItem>
        <ToggleGroupItem value="dark" aria-label={t('dark')}><Moon />{t('dark')}</ToggleGroupItem>
        <ToggleGroupItem value="system" aria-label={t('systemLabel')}><Monitor />{t('system')}</ToggleGroupItem>
      </ToggleGroup>
    </SettingRow>
  </SettingsSection>
}
