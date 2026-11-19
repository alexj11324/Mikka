'use client'

import { useId } from 'react'
import type { LinearLabelOption } from '@/lib/linear-sync/client'
import { useTranslations } from 'next-intl'
import { Plus, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { LINEAR_TRIGGER_EVENTS, type LinearTriggerEvent } from '@/lib/schedules/contract'
import type { LinearTriggerDraft } from './automation-draft'

export type LinearTeamOption = { id: string; key: string; name: string }

function labelSuggestions(input: LinearTriggerDraft, labels: LinearLabelOption[]) {
  const last = Math.max(input.labels.lastIndexOf(','), input.labels.lastIndexOf('，')) + 1
  const prefix = input.labels.slice(0, last)
  const chosen = new Set(prefix.split(/[,，]/).map(value => value.trim().toLowerCase()))
  return [...new Set(labels.filter(label => (!label.teamId || input.teams.includes(label.teamId)) && !chosen.has(label.name.toLowerCase()))
    .map(label => label.name))].map(name => prefix ? `${prefix} ${name}` : name)
}

/**
 * 满足任一条件就运行's Linear rows (decision 2026-11-15-1930): an event on one of the teams of the person's own Linear
 * connection, narrowed by labels, and an optional one-sentence condition checked before the run.
 */
export function LinearTriggers({ value, onChange, teams, labels, onEditLabels, connected, disabled }: { labels: LinearLabelOption[]; onEditLabels: () => void; value: LinearTriggerDraft[]; onChange: (next: LinearTriggerDraft[]) => void; teams: LinearTeamOption[]; connected: boolean; disabled?: boolean }) {
  const labelListId = useId()
  const t = useTranslations('Automations.editor.linear')
  const tEvent = useTranslations('Automations.linearEvent')
  const update = (index: number, patch: Partial<LinearTriggerDraft>) => onChange(value.map((item, at) => at === index ? { ...item, ...patch } : item))
  const add = () => onChange([...value, { event: 'issue_created', teams: teams[0] ? [teams[0].id] : [], labels: '', runWhen: '' }])
  const label = (id: string) => { const team = teams.find(item => item.id === id); return team ? `${team.key} · ${team.name}` : id }
  return <div className="flex flex-col gap-3 px-5 pb-4">
    {value.map((trigger, index) => <div key={index} role="group" aria-label={t('item', { number: index + 1 })} className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect size="sm" aria-label={t('event')} value={trigger.event} disabled={disabled} onChange={event => update(index, { event: event.target.value as LinearTriggerEvent })}>
          {LINEAR_TRIGGER_EVENTS.map(event => <NativeSelectOption key={event} value={event}>{tEvent(event)}</NativeSelectOption>)}
        </NativeSelect>
        {trigger.teams.length > 1
          ? <span className="text-sm text-muted-foreground">{trigger.teams.map(label).join(', ')}</span>
          : <NativeSelect size="sm" aria-label={t('team')} value={trigger.teams[0] ?? ''} disabled={disabled} onChange={event => update(index, { teams: event.target.value ? [event.target.value] : [] })}>
            <NativeSelectOption value="" disabled>{t('team')}</NativeSelectOption>
            {trigger.teams[0] && !teams.some(team => team.id === trigger.teams[0]) && <NativeSelectOption value={trigger.teams[0]}>{trigger.teams[0]}</NativeSelectOption>}
            {teams.map(team => <NativeSelectOption key={team.id} value={team.id}>{label(team.id)}</NativeSelectOption>)}
          </NativeSelect>}
        <Button size="icon-sm" variant="ghost" className="ms-auto" aria-label={t('remove')} disabled={disabled} onClick={() => onChange(value.filter((_, at) => at !== index))}><X /></Button>
      </div>
      <Input list={`${labelListId}-${index}`} onFocus={onEditLabels} aria-label={t('labels')} placeholder={t('labels')} value={trigger.labels} maxLength={1000} disabled={disabled} onChange={event => update(index, { labels: event.target.value })} />
      <datalist id={`${labelListId}-${index}`}>{labelSuggestions(trigger, labels).map(name => <option key={name} value={name} />)}</datalist>
      <Input aria-label={t('runWhen')} placeholder={t('runWhenPlaceholder')} value={trigger.runWhen} maxLength={500} disabled={disabled} onChange={event => update(index, { runWhen: event.target.value })} />
    </div>)}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={disabled || !teams.length || value.length >= 20} onClick={add}><Plus data-icon="inline-start" />{t('add')}</Button>
      {!connected && <span className="text-sm text-muted-foreground">{t('notConnected')}</span>}
      {connected && !teams.length && <span className="text-sm text-muted-foreground">{t('noTeams')}</span>}
    </div>
  </div>
}
