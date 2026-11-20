'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { Monitor, Moon, Sun } from '@/components/icons'
import { cn } from '@/lib/utils'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { useAppearance, type AppTheme } from '@/hooks/settings/use-preferences-page'

const MODES = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const satisfies readonly { value: AppTheme; icon: typeof Sun }[]

/** 外观, frame 1508:710. Display mode saves. The theme grid, colors, background and code options have no API. */
export function AppearanceSettings() {
  const t = useTranslations('Settings.appearance')
  const { mounted, theme, setTheme } = useAppearance()
  return <>
    <SettingsSection title={t('displayMode')}>
      <div className="flex gap-3 px-5 py-4" role="radiogroup" aria-label={t('themeLabel')}>
        {MODES.map(mode => {
          const Icon = mode.icon
          const selected = theme === mode.value
          const label = mode.value === 'system' ? t('system') : t(mode.value)
          return <button key={mode.value} type="button" role="radio" aria-checked={selected} disabled={!mounted} onClick={() => setTheme(mode.value)}
            className={cn('flex w-24 flex-col items-center gap-2 rounded-lg border p-2 text-xs', selected ? 'border-blue-600 ring-2 ring-blue-600' : 'border-border')}>
            <span className={cn('flex h-14 w-full items-center justify-center rounded-md', mode.value === 'light' ? 'bg-white text-black' : mode.value === 'dark' ? 'bg-neutral-900 text-white' : 'bg-gradient-to-r from-white to-neutral-900')}>
              <Icon />
            </span>
            {label}
          </button>
        })}
      </div>
      <SettingRow title={t('sync')} description={t('syncHint')}>
        <span className="text-sm text-muted-foreground">{t('unavailable')}</span>
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t('themes')}>
      <SettingRow title={t('themes')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
    </SettingsSection>
    <SettingsSection title={t('colors')}>
      <SettingRow title={t('accent')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
      <SettingRow title={t('fill')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
      <SettingRow title={t('foreground')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
      <SettingRow title={t('advanced')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
    </SettingsSection>
    <SettingsSection title={t('background')}>
      <SettingRow title={t('background')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
    </SettingsSection>
    <SettingsSection title={t('code')}>
      <SettingRow title={t('codeSize')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
      <SettingRow title={t('diffView')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
      <SettingRow title={t('diffColor')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
    </SettingsSection>
    <SettingsSection title={t('hidden')}>
      <SettingRow title={t('hidden')}><span className="text-sm text-muted-foreground">{t('unavailable')}</span></SettingRow>
    </SettingsSection>
  </>
}
