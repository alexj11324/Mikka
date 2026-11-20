'use client'

import { useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Pencil } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingRow, SettingSelect, SettingSwitch, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useUiPreferences } from '@/hooks/settings/use-ui-preferences'
import { RAIL_ITEMS } from '@/components/nav/rail-items'
import { RAIL_PAGE_IDS, type RailPageId, type RunKeyAction } from '@/lib/ui-preferences'

const ACTIONS = ['steer', 'interrupt', 'queue'] as const satisfies readonly RunKeyAction[]

/** 常规, frame 1508:588. Every row saves on user_preferences.uiPreferences and the client reads it back. */
export function GeneralInterface() {
  const t = useTranslations('Settings.appearance')
  const nav = useTranslations()
  const common = useTranslations('Common')
  const prefs = useUiPreferences()
  const [pagesOpen, setPagesOpen] = useState(false)
  const [draftPages, setDraftPages] = useState<RailPageId[]>([])
  if (prefs.loading) return <SettingsLoading label={t('interface')} rows={4} />
  if (prefs.denied) return <p role="status" className="text-sm text-muted-foreground">{t('noPermission')}</p>
  if (prefs.failed) return <SettingsSaveError message={t('unavailable')} retryLabel={common('retry')} onRetry={prefs.reload} />
  const { ui, save } = prefs
  const actionOptions = ACTIONS.map(value => ({ value, label: t(value) }))
  const pages = ui.sidebarPages ?? RAIL_PAGE_IDS
  return <>
    <SettingsSection title={t('interface')}>
      <SettingRow title={t('sidebarPages')} description={t('sidebarPagesHint')}>
        <Button type="button" size="icon" variant="ghost" aria-label={t('sidebarPages')} onClick={() => { setDraftPages([...pages]); setPagesOpen(true) }}><Pencil /></Button>
      </SettingRow>
      <SettingRow title={t('sidebarLayout')} description={t('sidebarLayoutHint')}>
        <SettingSelect label={t('sidebarLayout')} value={ui.sidebarLayout} options={[{ value: 'hybrid', label: t('hybrid') }, { value: 'columns', label: t('columns') }]} onValueChange={value => { if (value === 'hybrid' || value === 'columns') void save({ sidebarLayout: value }) }} />
      </SettingRow>
      <SettingRow title={t('pinPages')} description={t('pinPagesHint')}>
        <SettingSwitch label={t('pinPages')} checked={ui.pinPages} onCheckedChange={checked => { void save({ pinPages: checked }) }} />
      </SettingRow>
      <SettingRow title={t('openInApp')} description={t('openInAppHint')}>
        <SettingSwitch label={t('openInApp')} checked={ui.openInDesktop} onCheckedChange={checked => { void save({ openInDesktop: checked }) }} />
      </SettingRow>
      <SettingRow title={t('scrollTop')} description={t('scrollTopHint')}>
        <SettingSwitch label={t('scrollTop')} checked={ui.scrollNewToTop} onCheckedChange={checked => { void save({ scrollNewToTop: checked }) }} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t('input')}>
      <SettingRow title={t('enter')} description={t('enterHint')}>
        <SettingSelect label={t('enter')} value={ui.enterAction} options={actionOptions} onValueChange={value => { if (isAction(value)) void save({ enterAction: value }) }} />
      </SettingRow>
      <SettingRow title={t('modEnter')} description={t('modEnterHint')}>
        <SettingSelect label={t('modEnter')} value={ui.modEnterAction} options={actionOptions} onValueChange={value => { if (isAction(value)) void save({ modEnterAction: value }) }} />
      </SettingRow>
      <SettingRow title={t('altEnter')} description={t('altEnterHint')}>
        <SettingSelect label={t('altEnter')} value={ui.altEnterAction} options={actionOptions} onValueChange={value => { if (isAction(value)) void save({ altEnterAction: value }) }} />
      </SettingRow>
      <SettingRow title={t('microphone')} description={t('microphoneHint')}>
        <span className="text-sm text-muted-foreground">{t('systemDefault')}</span>
      </SettingRow>
    </SettingsSection>
    <Dialog open={pagesOpen} onOpenChange={setPagesOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('sidebarPages')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-2">
          {RAIL_ITEMS.map(item => {
            const checked = draftPages.includes(item.id)
            return <Label key={item.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{nav(item.label)}</span>
              <SettingSwitch label={nav(item.label)} checked={checked} onCheckedChange={next => {
                setDraftPages(current => next ? [...current, item.id] : current.filter(id => id !== item.id))
              }} />
            </Label>
          })}
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => { void save({ sidebarPages: draftPages.length === RAIL_PAGE_IDS.length ? null : draftPages }); setPagesOpen(false) }}>{common('save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

function isAction(value: string | null): value is RunKeyAction {
  return value === 'steer' || value === 'interrupt' || value === 'queue'
}
