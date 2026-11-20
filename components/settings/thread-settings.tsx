'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useWorkspaceGeneral } from '@/hooks/settings/use-workspace-general'
import { updatePreferences } from '@/app/actions/preferences'
import { useThreadTitleSettings } from '@/hooks/settings/use-thread-title-settings'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import type { ThreadTitleTriggers } from '@/lib/thread-title'

const TRIGGERS = ['first_run_ended', 'pull_opened', 'either'] as const satisfies readonly ThreadTitleTriggers[]
const ARCHIVE_DAYS = [3, 7, 14, 30, 90] as const
const PARALLEL = [1, 2, 4, 8, 16] as const
const DEPTH = [1, 2, 3, 4] as const

/** 线程, frame 1508:73. Title instructions and archive save. Sub-agent limits have no API. */
export function ThreadSettings({ workspaceId, personal }: { workspaceId?: string; personal: boolean }) {
  const t = useTranslations('Settings.threadTitles')
  const [scope, setScope] = useState<'mine' | 'workspace'>('mine')
  const shown = scope === 'workspace' && workspaceId && !personal ? 'workspace' : 'mine'
  return <>
    <p className="text-sm text-muted-foreground">{t('lead')}</p>
    {workspaceId && !personal ? <div className="flex gap-1" role="group" aria-label={`${t('scopeMine')} / ${t('scopeWorkspace')}`}>
      <Button type="button" size="sm" variant={shown === 'mine' ? 'secondary' : 'ghost'} aria-pressed={shown === 'mine'} onClick={() => setScope('mine')}>{t('scopeMine')}</Button>
      <Button type="button" size="sm" variant={shown === 'workspace' ? 'secondary' : 'ghost'} aria-pressed={shown === 'workspace'} onClick={() => setScope('workspace')}>{t('scopeWorkspace')}</Button>
    </div> : null}
    <TitleScope key={shown} scope={shown} workspaceId={shown === 'workspace' ? workspaceId : null} />
    {shown === 'mine' ? <ArchiveSection /> : null}
    <SubagentLimits workspaceId={workspaceId} />
  </>
}

function SubagentLimits({ workspaceId }: { workspaceId?: string }) {
  const t = useTranslations('Settings.threadTitles')
  const general = useWorkspaceGeneral(workspaceId)
  const current = general.data
  if (general.loading) return <SettingsLoading label={t('subagents')} rows={2} />
  if (!current) return null
  const parallel = PARALLEL.map(count => ({ value: String(count), label: t('countWorkspace', { count }) }))
  const depth = DEPTH.map(count => ({ value: String(count), label: t('countWorkspace', { count }) }))
  const busy = general.saving !== null
  return <SettingsSection title={t('subagents')} description={t('subagentsHint')}>
    <SettingRow title={t('parallel')} description={t('parallelHint')}>
      <SettingSelect label={t('parallel')} value={String(current.parallelSubagents)} disabled={!current.canEdit || busy} options={parallel} onValueChange={value => {
        const next = Number(value)
        if (PARALLEL.includes(next as typeof PARALLEL[number]) && next !== current.parallelSubagents) void general.patch({ parallelSubagents: next })
      }} />
    </SettingRow>
    <SettingRow title={t('depth')} description={t('depthHint')}>
      <SettingSelect label={t('depth')} value={String(current.nestDepth)} disabled={!current.canEdit || busy} options={depth} onValueChange={value => {
        const next = Number(value)
        if (DEPTH.includes(next as typeof DEPTH[number]) && next !== current.nestDepth) void general.patch({ nestDepth: next })
      }} />
    </SettingRow>
  </SettingsSection>
}

function TitleScope({ scope, workspaceId }: { scope: 'mine' | 'workspace'; workspaceId?: string | null }) {
  const t = useTranslations('Settings.threadTitles')
  const common = useTranslations('Common')
  const titles = useThreadTitleSettings(scope, workspaceId ?? null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (!titles.loaded && !titles.loadFailed) return <SettingsLoading label={t('title')} rows={2} />
  if (titles.loadFailed) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={titles.reload} />
  const triggerValue = titles.triggers ?? 'workspace'
  const options = [
    ...scope === 'mine' ? [{ value: 'workspace', label: t('inheritNever') }] : [],
    { value: 'first_run_ended', label: t('firstRunEnded') },
    { value: 'pull_opened', label: t('pullOpened') },
    { value: 'either', label: t('either') },
  ]
  return <SettingsSection title={t('title')}>
    <SettingRow title={t('command')} description={titles.instructions.trim() ? titles.instructions : t('none')}>
      <Button type="button" size="sm" variant="outline" disabled={!titles.canEdit || titles.busy} onClick={() => { setDraft(titles.instructions); setEditing(true) }}>{t('edit')}</Button>
    </SettingRow>
    <SettingRow title={t('regenerate')} description={t('triggersHint')}>
      <SettingSelect label={t('regenerate')} value={triggerValue} disabled={!titles.canEdit || titles.busy} options={options} onValueChange={value => {
        if (!value || value === triggerValue || !TRIGGERS.includes(value as ThreadTitleTriggers) && value !== 'workspace') return
        titles.setTriggers(value === 'workspace' ? null : value as ThreadTitleTriggers)
      }} />
    </SettingRow>
    {titles.message ? <p role={titles.message.kind === 'saved' ? 'status' : 'alert'} className="px-5 py-3 text-sm text-muted-foreground">{titles.message.text}</p> : null}
    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('command')}</DialogTitle></DialogHeader>
        <Textarea aria-label={t('command')} value={draft} maxLength={1000} rows={5} placeholder={t('placeholder')} onChange={event => setDraft(event.target.value)} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => setEditing(false)}>{common('cancel')}</Button>
          <Button type="button" onClick={() => { titles.commit(draft); setEditing(false) }}>{common('save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SettingsSection>
}

function ArchiveSection() {
  const t = useTranslations('Settings.threadTitles')
  const common = useTranslations('Common')
  const read = useSWR(settingsKeys.preferences(), () => settingsRead<{ archiveIdleAfterDays?: number; error?: string }>('preferences'))
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const days = read.data && !read.data.error ? read.data.archiveIdleAfterDays ?? 0 : null
  if (read.isLoading && days === null) return <SettingsLoading label={t('archive')} rows={1} />
  if (read.error || read.data?.error || days === null) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} />
  const options = [{ value: '0', label: t('archiveOff') }, ...ARCHIVE_DAYS.map(value => ({ value: String(value), label: t('archiveDays', { days: value }) }))]
  return <SettingsSection title={t('archive')}>
    <SettingRow title={t('archiveIdle')} description={t('archiveHint')}>
      <SettingSelect label={t('archiveIdle')} value={String(days)} disabled={busy} options={options} onValueChange={value => {
        const next = Number(value)
        if (!Number.isInteger(next) || next === days) return
        setBusy(true); setFailed(false)
        void updatePreferences({ archiveIdleAfterDays: next }).then(async result => {
          if ('error' in result && result.error) { setFailed(true); return }
          await read.mutate()
        }).catch(() => setFailed(true)).finally(() => setBusy(false))
      }} />
    </SettingRow>
    {failed ? <SettingsSaveError message={t('saveError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} /> : null}
  </SettingsSection>
}
