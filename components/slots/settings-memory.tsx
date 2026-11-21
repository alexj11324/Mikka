'use client'

import { useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Pencil, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingRow, SettingSwitch, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { USER_FACT_KINDS, type UserFactKind } from '@/lib/profile/kinds'
import { useMemorySettings, type MemoryFact as Fact } from '@/hooks/settings/use-memory-settings'

/** 记忆 (R-73): the person's facts as a Markdown-style summary, one heading per kind; each fact can be corrected or deleted. */
export function MemorySettings() {
  const t = useTranslations('Settings.memory')
  const common = useTranslations('Common')
  const { data, error, failed, reload, setEnabled, correct, remove, review } = useMemorySettings()
  const [editing, setEditing] = useState<{ id: string; subject: string } | null>(null)

  async function save() {
    if (!editing) return
    const { id, subject } = editing
    setEditing(null)
    await correct(id, subject)
  }

  const groups = USER_FACT_KINDS.map(kind => ({ kind, facts: data?.facts.filter(fact => fact.kind === kind) ?? [] })).filter(group => group.facts.length)

  return <div className="flex flex-col gap-6">
    <SettingsSection id="memory-heading" title={t('enabled')}>
      <SettingRow title={t('learn')}>
        <SettingSwitch label={t('learn')} checked={data?.enabled ?? true} disabled={!data} onCheckedChange={enabled => { void setEnabled(enabled) }} />
      </SettingRow>
    </SettingsSection>
    {(error || failed) && <SettingsSaveError message={t('error')} retryLabel={common('retry')} onRetry={() => { void reload() }} />}
    {/*
     * 待确认: every fact Mikka learns is written as `pending` and never reaches `facts`
     * until someone approves it, so without this list the person could neither see what
     * Mikka believes nor let any of it take effect.
     */}
    {data && data.pending.length > 0 && <SettingsSection id="memory-pending" title={t('pendingTitle')} description={t('pendingHint')}>
      {data.pending.map((fact: Fact) => <div key={fact.id} className="flex min-h-12 items-center gap-2 px-5 py-2 text-sm">
        <span className="min-w-0 flex-1">
          {fact.subject}
          <span className="ms-2 text-muted-foreground">{t(`kinds.${fact.kind as UserFactKind}`)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <Button variant="secondary" size="sm" onClick={() => { void review(fact.id, 'approve') }}>{t('approve')}</Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { void review(fact.id, 'reject') }}>{t('reject')}</Button>
        </span>
      </div>)}
    </SettingsSection>}
    {data && !groups.length && data.pending.length === 0 && <p className="px-1 text-sm text-muted-foreground">{t('empty')}</p>}
    {/* Each kind is a section card like every other settings group; a fact is a row whose 28px actions show on hover or focus (always on touch). */}
    {groups.map(group => <SettingsSection key={group.kind} id={`memory-${group.kind}`} title={t(`kinds.${group.kind as UserFactKind}`)}>
      {group.facts.map((fact: Fact) => <div key={fact.id} className="group/fact flex min-h-12 items-center gap-2 px-5 py-2 text-sm">
        {editing?.id === fact.id
          ? <Input autoFocus aria-label={t('correct')} value={editing.subject} maxLength={200} onChange={event => setEditing({ id: fact.id, subject: event.target.value })} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') void save(); if (event.key === 'Escape') setEditing(null) }} />
          : <>
              <span className="min-w-0 flex-1">
                {fact.subject}
                {/* A fact Mikka only believes inside one repository says so, so it is never
                    mistaken for one that holds wherever the person works (ALE-68). */}
                {fact.repository && <span className="ms-2 text-muted-foreground">{t('scopedTo', { repository: fact.repository })}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/fact:opacity-100 group-hover/fact:opacity-100 pointer-coarse:opacity-100">
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('correct')} onClick={() => setEditing({ id: fact.id, subject: fact.subject })}><Pencil data-icon="inline-start" /></Button>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('delete')} onClick={() => { void remove(fact.id) }}><Trash2 data-icon="inline-start" /></Button>
              </span>
            </>}
      </div>)}
    </SettingsSection>)}
  </div>
}
