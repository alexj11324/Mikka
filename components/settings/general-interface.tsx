'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'

const INTERFACE_ROWS = ['sidebarPages', 'sidebarLayout', 'pinPages', 'openInApp', 'scrollTop'] as const
const INPUT_ROWS = ['enter', 'modEnter', 'altEnter'] as const

/**
 * 常规, frame 1508:588. These rows have no saved setting yet, so the controls
 * stay unavailable instead of showing the frame's sample values.
 * 界面语言 and 重新播放引导 stay after this block: the frame has no row for them,
 * and both already save. 任务编号前缀 is on 工作区常规.
 */
export function GeneralInterface() {
  const t = useTranslations('Settings.appearance')
  return <>
    <SettingsSection title={t('interface')}>
      {INTERFACE_ROWS.map(id => <SettingRow key={id} title={t(id)} description={t(`${id}Hint` as 'sidebarPagesHint')}>
        <span className="text-sm text-muted-foreground">{t('unavailable')}</span>
      </SettingRow>)}
    </SettingsSection>
    <SettingsSection title={t('input')}>
      {INPUT_ROWS.map(id => <SettingRow key={id} title={t(id)} description={t(`${id}Hint` as 'enterHint')}>
        <span className="text-sm text-muted-foreground">{t('unavailable')}</span>
      </SettingRow>)}
      <SettingRow title={t('microphone')} description={t('microphoneHint')}>
        <span className="text-sm text-muted-foreground">{t('systemDefault')}</span>
      </SettingRow>
    </SettingsSection>
  </>
}
