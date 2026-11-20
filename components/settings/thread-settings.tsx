'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useThreadTitleSettings } from '@/hooks/settings/use-thread-title-settings'
import type { ThreadTitleTriggers } from '@/lib/thread-title'

const TRIGGERS = ['first_run_ended', 'pull_opened', 'either'] as const satisfies readonly ThreadTitleTriggers[]

/** 线程: the title instructions and when a generated title is written again. Workspace inheritance beyond this read stays on #2956. */
export function ThreadSettings({ workspaceId, personal }: { workspaceId?: string; personal: boolean }) {
  return <>
    <TitleScope scope="mine" />
    {workspaceId && !personal ? <TitleScope scope="workspace" workspaceId={workspaceId} /> : null}
  </>
}

function TitleScope({ scope, workspaceId = null }: { scope: 'mine' | 'workspace'; workspaceId?: string | null }) {
  const t = useTranslations('Settings.threadTitles')
  const groups = useTranslations('Settings.groups')
  const common = useTranslations('Common')
  const titles = useThreadTitleSettings(scope, workspaceId)
  if (!titles.loaded && !titles.loadFailed) return <SettingsLoading label={t('title')} rows={2} />
  if (titles.loadFailed) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={titles.reload} />
  const triggerValue = titles.triggers ?? 'workspace'
  const options = [
    ...scope === 'mine' ? [{ value: 'workspace', label: t('workspaceDefault') }] : [],
    ...TRIGGERS.map(value => ({ value, label: t(value) })),
  ]
  return <SettingsSection title={scope === 'mine' ? t('title') : groups('workspace')} description={scope === 'mine' ? t('instructionsMine') : t('instructionsWorkspace')}>
    <div className="flex flex-col gap-2 px-5 py-4">
      <label htmlFor={`thread-title-${scope}`} className="text-sm font-medium">{t('instructions')}</label>
      <textarea id={`thread-title-${scope}`} className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-sm" rows={3} maxLength={1000}
        value={titles.instructions} placeholder={t('placeholder')} disabled={!titles.canEdit || titles.busy}
        onChange={event => titles.type(event.target.value)} onBlur={titles.commit} />
    </div>
    <SettingRow title={t('triggers')} description={t('triggersHint')}>
      <select aria-label={t('triggers')} className="h-8 rounded-md border bg-background px-2 text-sm" value={triggerValue} disabled={!titles.canEdit || titles.busy} onChange={event => {
        const value = event.target.value
        if (value === triggerValue) return
        titles.setTriggers(value === 'workspace' ? null : value as ThreadTitleTriggers)
      }}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </SettingRow>
    {titles.message ? <p role={titles.message.kind === 'saved' ? 'status' : 'alert'} className="px-5 py-3 text-sm text-muted-foreground">{titles.message.text}</p> : null}
  </SettingsSection>
}
