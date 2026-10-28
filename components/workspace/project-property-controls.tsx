'use client'

import { useId, useState, type ReactNode } from 'react'
import { Box, Users, UserRound, CalendarDays, CalendarCheck, Tag, GitBranch, Plus, type LucideIcon } from 'lucide-react'
import { parseISO } from 'date-fns'
import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { hasDependencyCycle, type ProjectChanges, type ProjectDraft } from '@/lib/project-input'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { YearPicker } from '@/components/ui/year-picker'
import { Input } from '@/components/ui/input'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { PROJECT_HEALTH, PROJECT_PRIORITIES, PROJECT_STATUSES, type Project, type ProjectControlField } from './project-properties'

import { statusTone, statusDots, statusTones, type StatusTone } from '@/lib/status-appearance'
import { BadgeButton } from '@/components/reui/badge'

type Choice = { value: string; label: string; icon?: LucideIcon; description?: string; tone?: StatusTone }
export function ProjectPicker({ label, title, children, choices, selected, onChange, multiple = false, onCreate, createDisabled = false, disabled, plain = false, tone, dotOnly = false }: { dotOnly?: boolean; tone?: StatusTone; label: string; title: string; children: ReactNode; choices: Choice[]; selected: string[]; onChange: (value: string) => void; multiple?: boolean; onCreate?: (value: string) => void; createDisabled?: boolean; disabled?: boolean; plain?: boolean }) {
  const t = useTranslations('Projects')
  const common = useTranslations('Common')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [createDraft, setCreateDraft] = useState<string | null>(null)
  const id = useId()
  const duplicate = createDraft !== null && choices.some(item => item.value === createDraft.trim())
  function create() {
    const name = createDraft?.trim()
    if (!name || name.length > 50 || duplicate || disabled || createDisabled || !onCreate) return
    onCreate(name)
    setQuery('')
    setCreateDraft(null)
  }
  return <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) { setQuery(''); setCreateDraft(null) } }}>
    {dotOnly && tone ? <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={label} title={label} />}><span aria-hidden="true" className={cn('size-2.5 rounded-full', statusDots[tone])} /></PopoverTrigger> : tone ? <PopoverTrigger render={<BadgeButton disabled={disabled} variant="outline" size="xl" className={cn('cursor-pointer px-2 py-0.5 hover:brightness-95', statusTones[tone])} aria-label={label} />}>{choices.find(choice => selected.includes(choice.value))?.label ?? label}</PopoverTrigger> : <PopoverTrigger render={<Button type="button" variant={plain ? 'ghost' : 'outline'} size="sm" disabled={disabled} aria-label={label} className={cn('h-7 max-w-full justify-start gap-1.5', !plain && 'rounded-full px-2 text-muted-foreground', plain && 'px-2 font-normal')} />}>{children}</PopoverTrigger>}
    <PopoverContent align="start" className="w-64 p-0">
      <Command><CommandInput aria-label={t('picker.searchLabel', { label: title })} placeholder={t('picker.searchPlaceholder', { label: title })} value={query} onValueChange={setQuery} />
        <CommandList><CommandEmpty>{onCreate ? t('picker.noMatchesCreate') : t('picker.noOptions')}</CommandEmpty><CommandGroup heading={title}>{choices.map(choice => <CommandItem key={choice.value} disabled={disabled} value={`${choice.label} ${choice.value}`} data-checked={selected.includes(choice.value)} aria-selected={selected.includes(choice.value)} onSelect={() => { onChange(choice.value); if (!multiple) setOpen(false) }}>{choice.tone ? <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', statusDots[choice.tone])} /> : choice.icon && <choice.icon />}<span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate">{choice.label}</span>{choice.description && <span className="text-xs text-muted-foreground">{choice.description}</span>}</span></CommandItem>)}
          {onCreate && query.trim() && !choices.some(item => item.value === query.trim()) && <CommandItem disabled={disabled || createDisabled || query.trim().length > 50} value={query} onSelect={() => { onCreate(query.trim()); setQuery('') }}>{t('picker.createTag', { name: query.trim() })}</CommandItem>}
        </CommandGroup></CommandList>
      </Command>
      {onCreate && <div className="p-3">{createDraft === null ? <Button type="button" variant="ghost" size="sm" className="w-full justify-start" disabled={disabled || createDisabled} onClick={() => setCreateDraft(query.trim().slice(0, 50))}><Plus data-icon="inline-start" />{t('picker.newTag')}</Button> : <FieldGroup className="gap-3"><Field data-invalid={duplicate}><FieldLabel htmlFor={id}>{t('picker.tagName')}</FieldLabel><Input id={id} autoFocus value={createDraft} maxLength={50} placeholder={t('picker.tagNamePlaceholder')} aria-invalid={duplicate} aria-describedby={duplicate ? `${id}-error` : undefined} disabled={disabled} onChange={event => setCreateDraft(event.target.value)} onKeyDown={event => { event.stopPropagation(); if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter') { event.preventDefault(); create() } }} />{duplicate && <FieldError id={`${id}-error`}>{t('picker.tagExists')}</FieldError>}</Field><div className="flex gap-2"><Button type="button" size="sm" disabled={disabled || createDisabled || !createDraft.trim() || duplicate} onClick={create}><Plus data-icon="inline-start" />{t('picker.addTag')}</Button><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setCreateDraft(null)}>{common('cancel')}</Button></div></FieldGroup>}</div>}
    </PopoverContent>
  </Popover>
}

function ProjectDatePicker({ label, value, onChange, disabled, plain, min, max, icon: Icon }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; plain?: boolean; min?: string; max?: string; icon: LucideIcon }) {
  const t = useTranslations('Projects')
  const common = useTranslations('Common')
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const id = useId()
  const shown = value ? format.dateTime(parseISO(value), { month: 'short', day: 'numeric' }) : t('date.notSet')
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant={plain ? 'ghost' : 'outline'} size="sm" disabled={disabled} aria-label={common('propertyValue', { label, value: shown })} className={cn('h-7 justify-start gap-1.5', !plain && 'rounded-full px-2 text-muted-foreground', plain && 'px-2 font-normal')} />}><Icon data-icon="inline-start" />{value ? shown : plain ? t('date.notSet') : label}</PopoverTrigger>
    <PopoverContent align="start" className="w-auto p-2">
      <FieldGroup><Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Input id={id} aria-label={t('date.inputLabel', { label })} type="date" value={value} min={min || undefined} max={max || undefined} onChange={event => { const next = event.target.value; if (!next || (!min || next >= min) && (!max || next <= max)) onChange(next) }} /></Field></FieldGroup>
      <YearPicker label={label} value={value} min={min} max={max} disabled={disabled} onChange={date => { onChange(date); setOpen(false) }} />
      <Button type="button" variant="ghost" size="sm" disabled={!value} onClick={() => { onChange(''); setOpen(false) }}>{t('date.clear')}</Button>
    </PopoverContent>
  </Popover>
}

type ControlValue = { status: string; priority: string; lead: string; startDate: string; targetDate: string; properties: ProjectDraft['properties'] }
export function ProjectPropertyControl({ field, value, onChange, userName, projects = [], projectId, disabled, plain }: { field: ProjectControlField; value: ControlValue; onChange: (changes: ProjectChanges) => void; userName: string; projects?: Project[]; projectId?: string; disabled?: boolean; plain?: boolean }) {
  const t = useTranslations('Projects')
  const format = useFormatter()
  const shared = { disabled, plain }
  const label = (group: string, item: string) => t.has(`${group}.${item}` as never) ? t(`${group}.${item}` as never) : item
  const properties = value.properties
  const updateProperties = (changes: Partial<ProjectDraft['properties']>) => onChange({ properties: { ...properties, ...changes } })
  if (field === 'health') {
    const health = PROJECT_HEALTH.find(item => item.value === properties.health) ?? PROJECT_HEALTH[0]
    const healthLabel = label('health', health.value)
    return <ProjectPicker {...shared} dotOnly tone={statusTone(health.value)} title={t('fields.health')} label={t('controls.healthValue', { value: healthLabel })} choices={PROJECT_HEALTH.map(item => ({ ...item, tone: statusTone(item.value), label: label('health', item.value) }))} selected={[health.value]} onChange={health => updateProperties({ health: health as ProjectDraft['properties']['health'] })}><health.icon data-icon="inline-start" /><span className="truncate">{healthLabel}</span></ProjectPicker>
  }
  if (field === 'status') {
    const state = PROJECT_STATUSES.find(item => item.value === value.status) ?? PROJECT_STATUSES[0]
    const stateLabel = label('status', state.value)
    return <ProjectPicker {...shared} tone={statusTone(state.value)} title={t('fields.status')} label={t('controls.statusValue', { value: stateLabel })} choices={PROJECT_STATUSES.map(item => ({ ...item, tone: statusTone(item.value), label: label('status', item.value) }))} selected={[value.status]} onChange={status => onChange({ status: status as ProjectDraft['status'] })}><state.icon data-icon="inline-start" /><span className="truncate">{stateLabel}</span></ProjectPicker>
  }
  if (field === 'priority') {
    const priority = PROJECT_PRIORITIES.find(item => item.value === value.priority) ?? PROJECT_PRIORITIES[0]
    const priorityLabel = label('priority', priority.value)
    return <ProjectPicker {...shared} tone={statusTone(priority.value)} title={t('fields.priority')} label={t('controls.priorityValue', { value: priorityLabel })} choices={PROJECT_PRIORITIES.map(item => ({ ...item, tone: statusTone(item.value), label: label('priority', item.value) }))} selected={[value.priority]} onChange={priority => onChange({ priority: priority as ProjectDraft['priority'] })}><priority.icon data-icon="inline-start" /><span className="truncate">{priorityLabel}</span></ProjectPicker>
  }
  if (field === 'lead') return <ProjectPicker {...shared} title={t('fields.lead')} label={t('controls.leadValue', { value: value.lead ? userName : t('controls.leadUnset') })} choices={[{ value: '', label: t('controls.leadNone'), icon: UserRound }, { value: 'me', label: userName, icon: UserRound, description: t('controls.currentAccount') }]} selected={[value.lead]} onChange={lead => onChange({ lead: lead as '' | 'me' })}><UserRound data-icon="inline-start" /><span className="truncate">{value.lead ? userName : t('fields.lead')}</span></ProjectPicker>
  if (field === 'startDate' || field === 'targetDate') return <ProjectDatePicker {...shared} label={field === 'startDate' ? t('fields.startDate') : t('fields.targetDate')} icon={field === 'startDate' ? CalendarDays : CalendarCheck} value={value[field]} min={field === 'targetDate' ? value.startDate : undefined} max={field === 'startDate' ? value.targetDate : undefined} onChange={date => onChange({ [field]: date })} />
  if (field === 'members') return <ProjectPicker {...shared} title={t('fields.members')} label={t('fields.members')} multiple choices={[{ value: 'me', label: userName, icon: UserRound, description: t('controls.memberCurrentAccount') }]} selected={properties.members} onChange={() => updateProperties({ members: properties.members.length ? [] : ['me'] })}><Users data-icon="inline-start" />{properties.members.length ? `${userName}` : t('fields.members')}</ProjectPicker>
  if (field === 'labels') {
    const labels = [...new Set([...projects.flatMap(item => item.properties.labels), ...properties.labels])]
    const toggle = (label: string) => updateProperties({ labels: properties.labels.includes(label) ? properties.labels.filter(item => item !== label) : [...properties.labels, label] })
    return <ProjectPicker {...shared} title={t('fields.labels')} label={t('fields.labels')} multiple createDisabled={properties.labels.length >= 20} choices={labels.map(label => ({ value: label, label, icon: Tag }))} selected={properties.labels} onChange={toggle} onCreate={label => { if (label.length <= 50 && properties.labels.length < 20) toggle(label) }}><Tag data-icon="inline-start" /><span className="truncate">{properties.labels.length ? format.list(properties.labels, { type: 'conjunction' }) : t('fields.labels')}</span></ProjectPicker>
  }
  const dependencies = projects.filter(item => item.id !== projectId && (!projectId || !hasDependencyCycle(projectId, [item.id], projects)))
  return <ProjectPicker {...shared} title={t('fields.dependencyIds')} label={t('fields.dependencyIds')} multiple choices={dependencies.map(item => ({ value: item.id, label: item.name, icon: Box }))} selected={properties.dependencyIds} onChange={id => updateProperties({ dependencyIds: properties.dependencyIds.includes(id) ? properties.dependencyIds.filter(item => item !== id) : [...properties.dependencyIds, id] })}><GitBranch data-icon="inline-start" />{properties.dependencyIds.length ? t('controls.dependencyCount', { count: properties.dependencyIds.length }) : t('fields.dependencyIds')}</ProjectPicker>
}
