'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { Monitor, Moon, Sun } from '@/components/icons'
import { cn } from '@/lib/utils'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useUiPreferences } from '@/hooks/settings/use-ui-preferences'
import { UI_THEMES } from '@/lib/ui-preferences'
import { useTheme } from 'next-themes'

const MODES = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const

/** 外观, frame 1508:710. Display mode, the theme grid and the color fields save and paint the document. */
export function AppearanceSettings() {
  const t = useTranslations('Settings.appearance')
  const common = useTranslations('Common')
  const prefs = useUiPreferences()
  const { setTheme } = useTheme()
  if (prefs.loading) return <SettingsLoading label={t('displayMode')} rows={3} />
  if (prefs.denied) return <p role="status" className="text-sm text-muted-foreground">{t('noPermission')}</p>
  if (prefs.failed) return <SettingsSaveError message={t('unavailable')} retryLabel={common('retry')} onRetry={prefs.reload} />
  const { ui, save } = prefs
  return <>
    <SettingsSection title={t('displayMode')}>
      <div className="flex gap-3 px-5 py-4" role="radiogroup" aria-label={t('themeLabel')}>
        {MODES.map(mode => {
          const Icon = mode.icon
          const selected = ui.colorScheme === mode.value
          const label = mode.value === 'system' ? t('system') : t(mode.value)
          return <button key={mode.value} type="button" role="radio" aria-checked={selected} onClick={() => { setTheme(mode.value); void save({ colorScheme: mode.value }) }}
            className={cn('flex w-24 flex-col items-center gap-2 rounded-lg border p-2 text-xs', selected ? 'border-blue-600 ring-2 ring-blue-600' : 'border-border')}>
            <span className={cn('flex h-14 w-full items-center justify-center rounded-md', mode.value === 'light' ? 'bg-white text-black' : mode.value === 'dark' ? 'bg-neutral-900 text-white' : 'bg-gradient-to-r from-white to-neutral-900')}><Icon /></span>
            {label}
          </button>
        })}
      </div>
      <SettingRow title={t('sync')} description={t('syncHint')}>
        <SettingSelect label={t('sync')} value={ui.appearanceSync ? 'synced' : 'local'} options={[{ value: 'synced', label: t('synced') }, { value: 'local', label: t('notSynced') }]} onValueChange={value => { if (value === 'synced' || value === 'local') void save({ appearanceSync: value === 'synced' }) }} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t('themes')}>
      <div className="grid grid-cols-3 gap-2 p-4 sm:grid-cols-4">
        {UI_THEMES.map(theme => {
          const selected = ui.themeId === theme.id
          return <button key={theme.id} type="button" aria-pressed={selected} onClick={() => { void save({ themeId: theme.id, accent: theme.accent, fill: theme.fill, foreground: theme.foreground }) }}
            className={cn('flex flex-col gap-1 rounded-lg border p-2 text-left text-xs', selected && 'border-blue-600 ring-2 ring-blue-600')}>
            <span className="h-10 w-full rounded-md border" style={{ background: theme.fill, boxShadow: `inset 3px 0 0 ${theme.accent}` }} />
            {t(`theme_${theme.id}` as 'theme_mikka')}
          </button>
        })}
      </div>
    </SettingsSection>
    <SettingsSection title={t('colors')}>
      <ColorRow label={t('accent')} value={ui.accent} onChange={accent => { void save({ themeId: 'mikka', accent }) }} />
      <ColorRow label={t('fill')} value={ui.fill} onChange={fill => { void save({ themeId: 'mikka', fill }) }} />
      <ColorRow label={t('foreground')} value={ui.foreground} onChange={foreground => { void save({ themeId: 'mikka', foreground }) }} />
    </SettingsSection>
    <SettingsSection title={t('background')}>
      <SettingRow title={t('background')}>
        <SettingSelect label={t('background')} value={ui.background} options={[{ value: 'none', label: t('backgroundNone') }, { value: 'color', label: t('backgroundColor') }]} onValueChange={value => { if (value === 'none' || value === 'color') void save({ background: value }) }} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t('code')}>
      <SettingRow title={t('codeSize')}>
        <SettingSelect label={t('codeSize')} value={ui.codeSize} options={[{ value: 'default', label: t('codeDefault') }, { value: 'small', label: t('codeSmall') }, { value: 'large', label: t('codeLarge') }]} onValueChange={value => { if (value === 'default' || value === 'small' || value === 'large') void save({ codeSize: value }) }} />
      </SettingRow>
      <SettingRow title={t('diffView')}>
        <SettingSelect label={t('diffView')} value={ui.diffView} options={[{ value: 'unified', label: t('diffUnified') }, { value: 'split', label: t('diffSplit') }]} onValueChange={value => { if (value === 'unified' || value === 'split') void save({ diffView: value }) }} />
      </SettingRow>
      <SettingRow title={t('diffColor')}>
        <SettingSelect label={t('diffColor')} value={ui.diffColor} options={[{ value: 'redGreen', label: t('diffRedGreen') }, { value: 'blue', label: t('diffBlue') }]} onValueChange={value => { if (value === 'redGreen' || value === 'blue') void save({ diffColor: value }) }} />
      </SettingRow>
      <div data-diff-row className="px-5 py-3 font-mono text-xs" style={{ fontSize: 'var(--code-font-size, 14px)' }}>
        <div data-diff="remove">- removed</div>
        <div data-diff="add">+ added</div>
      </div>
    </SettingsSection>
    <SettingsSection title={t('hidden')}>
      <SettingRow title={t('hidden')}>
        <SettingSelect label={t('hidden')} value={ui.hiddenFiles} options={[{ value: 'hide', label: t('hiddenHide') }, { value: 'dim', label: t('hiddenDim') }, { value: 'show', label: t('hiddenShow') }]} onValueChange={value => { if (value === 'hide' || value === 'dim' || value === 'show') void save({ hiddenFiles: value }) }} />
      </SettingRow>
      <p className="px-5 py-3 text-sm"><span data-hidden-file>.env</span> <span>README</span></p>
    </SettingsSection>
  </>
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <SettingRow title={label}>
    <label className="flex items-center gap-2 text-sm">
      <input aria-label={label} type="color" value={value} onChange={event => onChange(event.target.value)} className="size-6 border-0 bg-transparent p-0" />
      <span className="font-mono text-xs">{value}</span>
    </label>
  </SettingRow>
}
