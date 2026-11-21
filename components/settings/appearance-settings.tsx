'use client'

import { useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { ChevronRight, Image, Pencil, Plus } from '@/components/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ColorSwatch } from '@/components/ui/color-swatch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useUiPreferences } from '@/hooks/settings/use-ui-preferences'
import { UI_THEMES, type UiPreferences } from '@/lib/ui-preferences'
import { useTheme } from 'next-themes'

const MODES = ['light', 'dark', 'system'] as const
const selectedFrame = 'border-2 border-sidebar-primary'

/** 外观, frame 1508:710. Display mode, themes, colors and background save and paint the document. */
export function AppearanceSettings() {
  const t = useTranslations('Settings.appearance')
  const common = useTranslations('Common')
  const prefs = useUiPreferences()
  const { setTheme } = useTheme()
  const [side, setSide] = useState<'light' | 'dark'>('light')
  const [advanced, setAdvanced] = useState(false)
  const [themesOpen, setThemesOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [themeName, setThemeName] = useState('')
  if (prefs.loading) return <SettingsLoading label={t('displayMode')} rows={3} />
  if (prefs.denied) return <p role="status" className="text-sm text-muted-foreground">{t('noPermission')}</p>
  if (prefs.failed) return <SettingsSaveError message={t('unavailable')} retryLabel={common('retry')} onRetry={prefs.reload} />
  const { ui, save } = prefs
  const accent = side === 'dark' ? ui.accentDark ?? ui.accent : ui.accent
  const fill = side === 'dark' ? ui.fillDark ?? ui.fill : ui.fill
  const foreground = side === 'dark' ? ui.foregroundDark ?? ui.foreground : ui.foreground
  function paint(patch: Partial<UiPreferences>) {
    void save(patch)
  }
  return <>
    <SettingsSection title={t('displayMode')}>
      <div className="grid grid-cols-3 gap-2 px-5 py-4" role="radiogroup" aria-label={t('themeLabel')}>
        {MODES.map(mode => {
          const selected = ui.colorScheme === mode
          const label = mode === 'system' ? t('system') : t(mode)
          return <Button key={mode} type="button" role="radio" aria-checked={selected} variant="outline" onClick={() => { setTheme(mode); paint({ colorScheme: mode }) }}
            className={cn('h-auto min-w-0 flex-col gap-2 p-2 text-xs', selected && selectedFrame)}>
            <ModeThumb mode={mode} />
            {label}
          </Button>
        })}
      </div>
      <SettingRow title={t('sync')} description={t('syncHint')}>
        <SettingSelect label={t('sync')} value={ui.appearanceSync ? 'synced' : 'local'} options={[{ value: 'synced', label: t('synced') }, { value: 'local', label: t('notSynced') }]} onValueChange={value => { if (value === 'synced' || value === 'local') paint({ appearanceSync: value === 'synced' }) }} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t('themes')} action={naming ? null : <Button type="button" variant="ghost" size="sm" onClick={() => setNaming(true)}><Plus data-icon />{t('createTheme')}</Button>}>
      <p className="px-5 pt-4 text-sm text-muted-foreground">{t('themeLead')}</p>
      <div className="grid grid-cols-2 gap-2 p-4 min-[720px]:grid-cols-6">
        {UI_THEMES.map(theme => {
          const selected = ui.themeId === theme.id
          return <Button key={theme.id} type="button" aria-pressed={selected} variant="outline" onClick={() => paint({ themeId: theme.id, accent: theme.accent, fill: theme.fill, foreground: theme.foreground })}
            className={cn('h-auto min-w-0 flex-col items-start gap-2 p-2 text-xs', selected && selectedFrame)}>
            <ThemeThumb fill={theme.fill} accent={theme.accent} foreground={theme.foreground} />
            {t(`theme_${theme.id}` as 'theme_mikka')}
          </Button>
        })}
      </div>
      {naming ? <div className="flex items-center gap-2 px-5 pb-4">
        <Input aria-label={t('themeName')} value={themeName} maxLength={40} onChange={event => setThemeName(event.target.value)} />
        <Button type="button" disabled={!themeName.trim()} onClick={() => {
          const name = themeName.trim()
          paint({ customThemes: [...ui.customThemes, { id: `custom-${ui.customThemes.length + 1}`, name, accent: ui.accent, fill: ui.fill, foreground: ui.foreground }] })
          setThemeName('')
          setNaming(false)
        }}>{common('save')}</Button>
      </div> : null}
    </SettingsSection>
    <SettingsSection title={t('colors')} action={<div className="flex gap-2" role="radiogroup" aria-label={t('colors')}>
      {(['light', 'dark'] as const).map(value => <Button key={value} type="button" role="radio" aria-checked={side === value} size="sm" variant={side === value ? 'secondary' : 'outline'} onClick={() => setSide(value)}>{t(value)}</Button>)}
    </div>}>
      <ColorRow label={t('accent')} value={accent} onChange={next => paint(side === 'dark' ? { accentDark: next } : { themeId: 'mikka', accent: next })} />
      <ColorRow label={t('surface')} value={fill} onChange={next => paint(side === 'dark' ? { fillDark: next } : { themeId: 'mikka', fill: next })} />
      <ColorRow label={t('foreground')} value={foreground} onChange={next => paint(side === 'dark' ? { foregroundDark: next } : { themeId: 'mikka', foreground: next })} />
    </SettingsSection>
    <Button type="button" variant="ghost" size="sm" className="self-start" aria-expanded={advanced} onClick={() => setAdvanced(open => !open)}>{t('advanced')}<ChevronRight data-icon /></Button>
    {advanced ? <SettingsSection><ColorRow label={t('border')} value={ui.border ?? '#e5e5e5'} onChange={border => paint({ border })} /></SettingsSection> : null}
    <SettingsSection title={t('explore')}>
      <Button type="button" variant="ghost" className="h-auto w-full justify-between rounded-none px-5 py-4" aria-expanded={themesOpen} onClick={() => setThemesOpen(open => !open)}>
        <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
          <span className="text-sm font-medium">{t('exploreCard')}</span>
          <span className="text-sm font-normal text-muted-foreground">{t('exploreHint')}</span>
        </span>
        <ChevronRight data-icon />
      </Button>
    </SettingsSection>
    {themesOpen ? <SettingsSection>
      {ui.customThemes.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">{t('myThemesEmpty')}</p> : ui.customThemes.map(theme => <SettingRow key={theme.id} title={theme.name}>
        <Button type="button" size="sm" variant="outline" onClick={() => paint({ themeId: 'mikka', accent: theme.accent, fill: theme.fill, foreground: theme.foreground })}>{t('useTheme')}</Button>
      </SettingRow>)}
    </SettingsSection> : null}
    <SettingsSection title={t('background')}>
      <SettingRow title={t('dashboardBackground')} description={t('dashboardHint')}>
        <div className="flex items-center gap-2">
          <ColorSwatch shape="tile" color={ui.background === 'color' ? ui.accent : undefined} className={cn('flex size-8 items-center justify-center', ui.background === 'color' ? 'text-primary-foreground' : 'bg-muted text-foreground')} aria-hidden>
            <Image data-icon />
          </ColorSwatch>
          <Button type="button" variant="ghost" size="icon" aria-label={t('editBackground')} onClick={() => paint({ background: ui.background === 'color' ? 'none' : 'color' })}>
            <Pencil data-icon />
          </Button>
        </div>
      </SettingRow>
      <SettingRow title={t('backgroundEffect')}>
        <SettingSelect label={t('backgroundEffect')} value={ui.backgroundEffect} options={[{ value: 'colorful', label: t('effectColorful') }, { value: 'none', label: t('backgroundNone') }]} onValueChange={value => { if (value === 'none' || value === 'colorful') paint({ backgroundEffect: value }) }} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t('code')}>
      <SettingRow title={t('codeSize')} description={t('codeSizeHint')}>
        <SettingSelect label={t('codeSize')} value={ui.codeSize} options={[{ value: 'default', label: t('codeDefault') }, { value: 'small', label: t('codeSmall') }, { value: 'large', label: t('codeLarge') }]} onValueChange={value => { if (value === 'default' || value === 'small' || value === 'large') paint({ codeSize: value }) }} />
      </SettingRow>
      <SettingRow title={t('diffView')} description={t('diffViewHint')}>
        <SettingSelect label={t('diffView')} value={ui.diffView} options={[{ value: 'unified', label: t('diffUnified') }, { value: 'split', label: t('diffSplit') }]} onValueChange={value => { if (value === 'unified' || value === 'split') paint({ diffView: value }) }} />
      </SettingRow>
      <SettingRow title={t('diffColor')} description={t('diffColorHint')}>
        <SettingSelect label={t('diffColor')} value={ui.diffColor} options={[{ value: 'redGreen', label: t('diffRedGreen') }, { value: 'blue', label: t('diffBlue') }]} onValueChange={value => { if (value === 'redGreen' || value === 'blue') paint({ diffColor: value }) }} />
      </SettingRow>
    </SettingsSection>
    <DiffPreview color={ui.diffColor} />
    <SettingsSection title={t('hidden')}>
      <SettingRow title={t('hiddenFold')} description={t('hiddenFoldHint')}>
        <SettingSelect fluid label={t('hiddenFold')} value={ui.hiddenFiles} options={[{ value: 'generated', label: t('hiddenGenerated') }, { value: 'none', label: t('hiddenNone') }, { value: 'all', label: t('hiddenAll') }]} onValueChange={value => { if (value === 'generated' || value === 'none' || value === 'all') paint({ hiddenFiles: value }) }} />
      </SettingRow>
    </SettingsSection>
  </>
}

function ModeThumb({ mode }: { mode: 'light' | 'dark' | 'system' }) {
  const light = mode !== 'dark'
  const dark = mode !== 'light'
  return <span className="flex h-14 w-full overflow-hidden rounded-md">
    {light ? <ColorSwatch color="#ffffff" className="flex flex-1"><ColorSwatch color="#e7e5e4" className="m-1 w-3" /><ColorSwatch color="#d6d3d1" className="m-1 h-2 flex-1" /></ColorSwatch> : null}
    {dark ? <ColorSwatch color="#171717" className="flex flex-1"><ColorSwatch color="#404040" className="m-1 w-3" /><ColorSwatch color="#525252" className="m-1 h-2 flex-1" /></ColorSwatch> : null}
  </span>
}

function ThemeThumb({ fill, accent, foreground }: { fill: string; accent: string; foreground: string }) {
  return <ColorSwatch color={fill} shape="tile" className="flex h-16 w-full">
    <ColorSwatch color={accent} className="w-5" />
    <span className="flex flex-1 flex-col gap-1 p-1.5">
      <ColorSwatch color={foreground} className="h-1.5 w-8 rounded-full" />
      <ColorSwatch color={foreground} className="h-1 w-full rounded-full opacity-30" />
      <ColorSwatch color={accent} className="mt-auto h-4 w-full rounded-sm opacity-80" />
    </span>
  </ColorSwatch>
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <SettingRow title={label}>
    <Label className="flex h-7 items-center gap-2 rounded-full border bg-background px-1.5 pr-2.5 text-sm">
      <ColorSwatch color={value} shape="chip" />
      <span className="font-mono text-xs">{value}</span>
      <Input aria-label={label} type="color" value={value} onChange={event => onChange(event.target.value)} className="sr-only" />
    </Label>
  </SettingRow>
}

function DiffPreview({ color }: { color: 'redGreen' | 'blue' }) {
  const blue = color === 'blue'
  const row = (mark: string, text: string, kind?: 'removed' | 'added') => <div className={cn(
    'grid grid-cols-[1.25rem_minmax(0,1fr)] px-3',
    kind === 'removed' && blue && 'bg-sidebar-primary/20',
    kind === 'removed' && !blue && 'bg-destructive/15',
    kind === 'added' && blue && 'bg-attention/25',
    kind === 'added' && !blue && 'bg-success/15',
  )}>
    <span>{mark}</span>
    <span className="min-w-0 break-all">{text}</span>
  </div>
  return <pre className="rounded-xl border bg-card font-mono text-xs leading-6 whitespace-pre-wrap">
    {row('1', 'export function add(a: number, b: number) {')}
    {row('-', 'return a - b;', 'removed')}
    {row('+', 'return a + b;', 'added')}
    {row('3', '}')}
  </pre>
}
