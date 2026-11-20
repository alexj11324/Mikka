'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { LocaleSetting } from '@/components/settings/locale-setting'
import { ReplayOnboarding } from '@/components/settings/workspace-settings'

/** 界面语言 and 重新播放引导. The frame has no row for either; both already save. The task prefix is on 工作区常规. */
export function PreferencesSettings() {
  const t = useTranslations('Settings.appearance')
  return <>
    <SettingsSection id="language-heading">
      <SettingRow title={t('language')}><LocaleSetting /></SettingRow>
    </SettingsSection>
    <ReplayOnboarding />
  </>
}
