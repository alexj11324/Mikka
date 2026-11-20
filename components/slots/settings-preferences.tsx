'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { LocaleSetting } from '@/components/settings/locale-setting'
import { IssuePrefixSettings } from '@/components/settings/issue-prefix-settings'
import { ReplayOnboarding } from '@/components/settings/workspace-settings'

/** 界面语言 and 重新播放引导 stay; the frame has no row for either. The personal task prefix stays here. The workspace prefix is on 工作区资料. */
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
