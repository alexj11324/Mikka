'use client'

import { useId, useState, type ReactNode } from 'react'
import { Box, Users, UserRound, CalendarDays, CalendarCheck, Tag, GitBranch, Plus, type LucideIcon } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { cn } from '@/lib/utils'
import { hasDependencyCycle, type ProjectChanges, type ProjectDraft } from '@/lib/project-input'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { PROJECT_HEALTH, PROJECT_PRIORITIES, PROJECT_STATUSES, type Project, type ProjectControlField } from './project-properties'

type Choice = { value: string; label: string; icon?: LucideIcon; description?: string }
export function ProjectPicker({ label, children, choices, selected, onChange, multiple = false, onCreate, createDisabled = false, disabled, plain = false }: { label: string; children: ReactNode; choices: Choice[]; selected: string[]; onChange: (value: string) => void; multiple?: boolean; onCreate?: (value: string) => void; createDisabled?: boolean; disabled?: boolean; plain?: boolean }) {
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
    <PopoverTrigger render={<Button type="button" variant={plain ? 'ghost' : 'outline'} size="sm" disabled={disabled} aria-label={label} className={cn('h-7 max-w-full justify-start gap-1.5', !plain && 'rounded-full bg-muted/40 px-2 text-muted-foreground', plain && 'px-2 font-normal')} />}>{children}</PopoverTrigger>
    <PopoverContent align="start" className="w-64 p-0">
      <Command><CommandInput aria-label={`搜索${label}`} placeholder={`搜索${label.split('：')[0]}…`} value={query} onValueChange={setQuery} />
        <CommandList><CommandEmpty>{onCreate ? '暂无匹配标签，可在下方新建。' : '没有可选项'}</CommandEmpty><CommandGroup heading={label.split('：')[0]}>{choices.map(choice => <CommandItem key={choice.value} disabled={disabled} value={`${choice.label} ${choice.value}`} data-checked={selected.includes(choice.value)} aria-selected={selected.includes(choice.value)} onSelect={() => { onChange(choice.value); if (!multiple) setOpen(false) }}>{choice.icon && <choice.icon />}<span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate">{choice.label}</span>{choice.description && <span className="text-xs text-muted-foreground">{choice.description}</span>}</span></CommandItem>)}
          {onCreate && query.trim() && !choices.some(item => item.value === query.trim()) && <CommandItem disabled={disabled || createDisabled || query.trim().length > 50} value={query} onSelect={() => { onCreate(query.trim()); setQuery('') }}>创建标签「{query.trim()}」</CommandItem>}
        </CommandGroup></CommandList>
      </Command>
      {onCreate && <div className="border-t p-3">{createDraft === null ? <Button type="button" variant="ghost" size="sm" className="w-full justify-start" disabled={disabled || createDisabled} onClick={() => setCreateDraft(query.trim().slice(0, 50))}><Plus data-icon="inline-start" />新建标签</Button> : <FieldGroup className="gap-3"><Field data-invalid={duplicate}><FieldLabel htmlFor={id}>标签名称</FieldLabel><Input id={id} autoFocus value={createDraft} maxLength={50} placeholder="输入新标签名称…" aria-invalid={duplicate} aria-describedby={duplicate ? `${id}-error` : undefined} disabled={disabled} onChange={event => setCreateDraft(event.target.value)} onKeyDown={event => { event.stopPropagation(); if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter') { event.preventDefault(); create() } }} />{duplicate && <FieldError id={`${id}-error`}>标签已存在，请在上方选择。</FieldError>}</Field><div className="flex gap-2"><Button type="button" size="sm" disabled={disabled || createDisabled || !createDraft.trim() || duplicate} onClick={create}><Plus data-icon="inline-start" />添加标签</Button><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setCreateDraft(null)}>取消</Button></div></FieldGroup>}</div>}
    </PopoverContent>
  </Popover>
}

function ProjectDatePicker({ label, value, onChange, disabled, plain, min, max, icon: Icon }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; plain?: boolean; min?: string; max?: string; icon: LucideIcon }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant={plain ? 'ghost' : 'outline'} size="sm" disabled={disabled} aria-label={`${label}：${value || '未设置'}`} className={cn('h-7 justify-start gap-1.5', !plain && 'rounded-full bg-muted/40 px-2 text-muted-foreground', plain && 'px-2 font-normal')} />}><Icon data-icon="inline-start" />{value ? format(parseISO(value), 'M月d日') : plain ? '未设置' : label}</PopoverTrigger>
    <PopoverContent align="start" className="w-auto p-2">
      <FieldGroup><Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Input id={id} aria-label={`输入${label}`} type="date" value={value} min={min || undefined} max={max || undefined} onChange={event => { const next = event.target.value; if (!next || (!min || next >= min) && (!max || next <= max)) onChange(next) }} /></Field></FieldGroup>
      <Calendar mode="single" locale={zhCN} selected={value ? parseISO(value) : undefined} defaultMonth={value ? parseISO(value) : undefined} disabled={day => Boolean(min && format(day, 'yyyy-MM-dd') < min || max && format(day, 'yyyy-MM-dd') > max)} onSelect={day => { onChange(day ? format(day, 'yyyy-MM-dd') : ''); setOpen(false) }} />
      <Button type="button" variant="ghost" size="sm" disabled={!value} onClick={() => { onChange(''); setOpen(false) }}>清除日期</Button>
    </PopoverContent>
  </Popover>
}

type ControlValue = { status: string; priority: string; lead: string; startDate: string; targetDate: string; properties: ProjectDraft['properties'] }
export function ProjectPropertyControl({ field, value, onChange, userName, projects = [], projectId, disabled, plain }: { field: ProjectControlField; value: ControlValue; onChange: (changes: ProjectChanges) => void; userName: string; projects?: Project[]; projectId?: string; disabled?: boolean; plain?: boolean }) {
  const shared = { disabled, plain }
  const properties = value.properties
  const updateProperties = (changes: Partial<ProjectDraft['properties']>) => onChange({ properties: { ...properties, ...changes } })
  if (field === 'health') {
    const health = PROJECT_HEALTH.find(item => item.value === properties.health) ?? PROJECT_HEALTH[0]
    return <ProjectPicker {...shared} label={`健康度：${health.label}`} choices={[...PROJECT_HEALTH]} selected={[health.value]} onChange={health => updateProperties({ health: health as ProjectDraft['properties']['health'] })}><health.icon data-icon="inline-start" /><span className="truncate">{health.label}</span></ProjectPicker>
  }
  if (field === 'status') {
    const state = PROJECT_STATUSES.find(item => item.value === value.status) ?? PROJECT_STATUSES[0]
    return <ProjectPicker {...shared} label={`状态：${state.label}`} choices={[...PROJECT_STATUSES]} selected={[value.status]} onChange={status => onChange({ status: status as ProjectDraft['status'] })}><state.icon data-icon="inline-start" /><span className="truncate">{state.label}</span></ProjectPicker>
  }
  if (field === 'priority') {
    const priority = PROJECT_PRIORITIES.find(item => item.value === value.priority) ?? PROJECT_PRIORITIES[0]
    return <ProjectPicker {...shared} label={`优先级：${priority.label}`} choices={[...PROJECT_PRIORITIES]} selected={[value.priority]} onChange={priority => onChange({ priority: priority as ProjectDraft['priority'] })}><priority.icon data-icon="inline-start" /><span className="truncate">{priority.label}</span></ProjectPicker>
  }
  if (field === 'lead') return <ProjectPicker {...shared} label={`负责人：${value.lead ? userName : '未指定'}`} choices={[{ value: '', label: '未指定负责人', icon: UserRound }, { value: 'me', label: userName, icon: UserRound, description: '当前账号' }]} selected={[value.lead]} onChange={lead => onChange({ lead: lead as '' | 'me' })}><UserRound data-icon="inline-start" /><span className="truncate">{value.lead ? userName : '负责人'}</span></ProjectPicker>
  if (field === 'startDate' || field === 'targetDate') return <ProjectDatePicker {...shared} label={field === 'startDate' ? '开始日期' : '目标日期'} icon={field === 'startDate' ? CalendarDays : CalendarCheck} value={value[field]} min={field === 'targetDate' ? value.startDate : undefined} max={field === 'startDate' ? value.targetDate : undefined} onChange={date => onChange({ [field]: date })} />
  if (field === 'members') return <ProjectPicker {...shared} multiple label="成员" choices={[{ value: 'me', label: userName, icon: UserRound, description: '当前可访问账号' }]} selected={properties.members} onChange={() => updateProperties({ members: properties.members.length ? [] : ['me'] })}><Users data-icon="inline-start" />{properties.members.length ? `${userName}` : '成员'}</ProjectPicker>
  if (field === 'labels') {
    const labels = [...new Set([...projects.flatMap(item => item.properties.labels), ...properties.labels])]
    const toggle = (label: string) => updateProperties({ labels: properties.labels.includes(label) ? properties.labels.filter(item => item !== label) : [...properties.labels, label] })
    return <ProjectPicker {...shared} multiple label="标签" createDisabled={properties.labels.length >= 20} choices={labels.map(label => ({ value: label, label, icon: Tag }))} selected={properties.labels} onChange={toggle} onCreate={label => { if (label.length <= 50 && properties.labels.length < 20) toggle(label) }}><Tag data-icon="inline-start" /><span className="truncate">{properties.labels.length ? properties.labels.join('、') : '标签'}</span></ProjectPicker>
  }
  const dependencies = projects.filter(item => item.id !== projectId && (!projectId || !hasDependencyCycle(projectId, [item.id], projects)))
  return <ProjectPicker {...shared} multiple label="依赖项目" choices={dependencies.map(item => ({ value: item.id, label: item.name, icon: Box }))} selected={properties.dependencyIds} onChange={id => updateProperties({ dependencyIds: properties.dependencyIds.includes(id) ? properties.dependencyIds.filter(item => item !== id) : [...properties.dependencyIds, id] })}><GitBranch data-icon="inline-start" />{properties.dependencyIds.length ? `${properties.dependencyIds.length} 个依赖` : '依赖'}</ProjectPicker>
}
