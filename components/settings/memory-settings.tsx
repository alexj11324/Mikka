'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { getMemory, removeFact, setMemory, updateFact } from '@/app/actions/memory'
import { USER_FACT_KINDS, type UserFactKind } from '@/lib/profile/kinds'
import { FieldError } from '@/components/ui/field'

type Memory = Awaited<ReturnType<typeof getMemory>>
type Fact = Memory['facts'][number]

/** 记忆 (R-73): the person's facts as a Markdown-style summary, one heading per kind; each fact can be corrected or deleted. */
export function MemorySettings() {
  const t = useTranslations('Settings.memory')
  const { data, error, mutate } = useSWR('memory', getMemory)
  const [editing, setEditing] = useState<{ id: string; subject: string } | null>(null)
  const [failed, setFailed] = useState(false)

  async function run(change: () => Promise<unknown>, next: (current: Memory) => Memory) {
    const shown = data
    if (!shown) return
    setFailed(false)
    try {
      await mutate(async current => { await change(); return next(current ?? shown) }, { optimisticData: current => next(current ?? shown), rollbackOnError: true, revalidate: false })
    } catch {
      setFailed(true)
    }
  }

  async function save() {
    if (!editing) return
    const { id, subject } = editing
    setEditing(null)
    if (!subject.trim()) return
    await run(() => updateFact(id, subject), current => ({ ...current, facts: current.facts.map(fact => fact.id === id ? { ...fact, subject: subject.trim(), userEdited: true } : fact) }))
  }

  const groups = USER_FACT_KINDS.map(kind => ({ kind, facts: data?.facts.filter(fact => fact.kind === kind) ?? [] })).filter(group => group.facts.length)

  return <div className="flex flex-col gap-6">
    <SettingsSection id="memory-heading" title={t('enabled')}>
      <SettingRow title={t('learn')}>
        <Switch aria-label={t('learn')} checked={data?.enabled ?? true} disabled={!data} onCheckedChange={enabled => run(() => setMemory(enabled), current => ({ ...current, enabled }))} />
      </SettingRow>
    </SettingsSection>
    {(error || failed) && <FieldError className="px-1">{t('error')}</FieldError>}
    {data && !groups.length && <p className="px-1 text-sm text-muted-foreground">{t('empty')}</p>}
    {/* Each kind is a section card like every other settings group; a fact is a row whose 28px actions show on hover or focus (always on touch). */}
    {groups.map(group => <SettingsSection key={group.kind} id={`memory-${group.kind}`} title={t(`kinds.${group.kind as UserFactKind}`)}>
      {group.facts.map((fact: Fact) => <div key={fact.id} className="group/fact flex min-h-12 items-center gap-2 px-5 py-2 text-sm">
        {editing?.id === fact.id
          ? <Input autoFocus aria-label={t('correct')} value={editing.subject} maxLength={200} onChange={event => setEditing({ id: fact.id, subject: event.target.value })} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') void save(); if (event.key === 'Escape') setEditing(null) }} />
          : <>
              <span className="min-w-0 flex-1">{fact.subject}</span>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/fact:opacity-100 group-hover/fact:opacity-100 pointer-coarse:opacity-100">
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('correct')} onClick={() => setEditing({ id: fact.id, subject: fact.subject })}><Pencil data-icon="inline-start" /></Button>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('delete')} onClick={() => run(() => removeFact(fact.id), current => ({ ...current, facts: current.facts.filter(item => item.id !== fact.id) }))}><Trash2 data-icon="inline-start" /></Button>
              </span>
            </>}
      </div>)}
    </SettingsSection>)}
  </div>
}
