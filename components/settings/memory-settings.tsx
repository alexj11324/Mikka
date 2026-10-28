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
    {(error || failed) && <p role="alert" className="px-1 text-sm text-destructive">{t('error')}</p>}
    {data && !groups.length && <p className="px-1 text-sm text-muted-foreground">{t('empty')}</p>}
    {groups.map(group => <section key={group.kind} aria-labelledby={`memory-${group.kind}`} className="flex flex-col gap-2 px-1">
      <h2 id={`memory-${group.kind}`} className="text-base font-semibold">{t(`kinds.${group.kind as UserFactKind}`)}</h2>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {group.facts.map((fact: Fact) => <li key={fact.id} className="group/fact">
          {editing?.id === fact.id
            ? <Input autoFocus aria-label={t('correct')} value={editing.subject} maxLength={200} className="h-7" onChange={event => setEditing({ id: fact.id, subject: event.target.value })} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') void save(); if (event.key === 'Escape') setEditing(null) }} />
            : <span className="inline-flex items-center gap-1">
                <span>{fact.subject}</span>
                <Button variant="ghost" size="icon-xs" aria-label={t('correct')} onClick={() => setEditing({ id: fact.id, subject: fact.subject })}><Pencil data-icon="inline-start" /></Button>
                <Button variant="ghost" size="icon-xs" aria-label={t('delete')} onClick={() => run(() => removeFact(fact.id), current => ({ ...current, facts: current.facts.filter(item => item.id !== fact.id) }))}><Trash2 data-icon="inline-start" /></Button>
              </span>}
        </li>)}
      </ul>
    </section>)}
  </div>
}
