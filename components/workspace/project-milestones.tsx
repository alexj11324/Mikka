'use client'

import { useState } from 'react'
import { Flag, Plus, Trash2, ChevronDown } from 'lucide-react'
import type { ProjectDraft } from '@/lib/project-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

type Milestone = ProjectDraft['properties']['milestones'][number]
export function ProjectMilestones({ value, onChange, disabled }: { value: Milestone[]; onChange: (value: Milestone[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(value.length > 0)
  function update(id: string, changes: Partial<Milestone>) { onChange(value.map(item => item.id === id ? { ...item, ...changes } : item)) }
  function add() { if (value.length >= 50) return; onChange([...value, { id: crypto.randomUUID(), name: '', targetDate: '', completed: false }]); setOpen(true) }
  return <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border">
    <div className="flex items-center justify-between gap-2 p-3"><CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="flex-1 justify-start" />}><ChevronDown data-icon="inline-start" />里程碑{value.length > 0 && <span className="text-muted-foreground">{value.filter(item => item.completed).length}/{value.length}</span>}</CollapsibleTrigger><Button type="button" variant="ghost" size="icon-sm" aria-label="添加里程碑" disabled={disabled || value.length >= 50} onClick={add}><Plus data-icon="inline-start" /></Button></div>
    <CollapsibleContent><div className="flex flex-col gap-3 px-4 pb-4">{value.length === 0 ? <p className="text-sm text-muted-foreground">添加阶段性目标，跟踪项目交付。</p> : value.map((item, index) => <div key={item.id} className="flex flex-wrap items-center gap-2"><FieldGroup className="min-w-0 flex-1 flex-row items-center gap-2"><Field className="w-auto"><FieldLabel className="sr-only" htmlFor={`milestone-check-${item.id}`}>完成里程碑 {index + 1}</FieldLabel><Checkbox id={`milestone-check-${item.id}`} checked={item.completed} disabled={disabled} onCheckedChange={checked => update(item.id, { completed: Boolean(checked) })} /></Field><Field className="min-w-32 flex-1"><FieldLabel className="sr-only" htmlFor={`milestone-name-${item.id}`}>里程碑 {index + 1} 名称</FieldLabel><Input id={`milestone-name-${item.id}`} value={item.name} maxLength={200} placeholder="里程碑名称" required disabled={disabled} onChange={event => update(item.id, { name: event.target.value })} /></Field><Field className="w-36"><FieldLabel className="sr-only" htmlFor={`milestone-date-${item.id}`}>里程碑 {index + 1} 日期</FieldLabel><Input id={`milestone-date-${item.id}`} type="date" value={item.targetDate} disabled={disabled} onChange={event => update(item.id, { targetDate: event.target.value })} /></Field></FieldGroup><Button type="button" variant="ghost" size="icon-sm" aria-label={`移除里程碑 ${index + 1}`} disabled={disabled} onClick={() => onChange(value.filter(value => value.id !== item.id))}><Trash2 data-icon="inline-start" /></Button></div>)}{value.length > 0 && <Button type="button" variant="ghost" size="sm" className="self-start" disabled={disabled || value.length >= 50} onClick={add}><Flag data-icon="inline-start" />添加里程碑</Button>}</div></CollapsibleContent>
  </Collapsible>
}
