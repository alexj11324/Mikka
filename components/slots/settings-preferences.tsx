'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { LocaleSetting } from '@/components/settings/locale-setting'
import { IssuePrefixSettings } from '@/components/settings/issue-prefix-settings'
import { ReplayOnboarding } from '@/components/settings/workspace-settings'

/** 常规: language, the task prefix, 重新播放引导. Theme lives on 外观. */
export function PreferencesSettings() {
  const t = useTranslations('Settings.appearance')
  return <>
    <SettingsSection id="language-heading">
      <SettingRow title={t('language')}><LocaleSetting /></SettingRow>
    </SettingsSection>
    <IssuePrefixSettings />
    <ReplayOnboarding />
  </>
}
