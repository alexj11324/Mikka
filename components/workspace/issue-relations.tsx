'use client'

import { useRef, useState } from 'react'
import useSWR from 'swr'
import { ChevronDown, ChevronRight, Circle, Flag, GitBranch, Link2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { listIssueConnections, updateIssueRelation } from '@/app/actions/issue-operations'
import { moveIssue, type getIssue } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { ISSUE_STATUSES, issueIdentifier } from './issue-properties'
import { IssuePropertyMenu } from './issue-property-menu'
import { cn } from '@/lib/utils'

type Issue = Awaited<ReturnType<typeof getIssue>>
export type RelationKind = 'parent' | 'child' | 'related' | 'blockedBy' | 'blocks' | 'duplicate'
export const RELATION_TITLES: Record<RelationKind, string> = { parent: '设置父任务', child: '添加现有子任务', related: '添加关联任务', blockedBy: '被以下任务阻塞', blocks: '阻塞以下任务', duplicate: '标记为重复任务' }
const closed = (status: string) => ['done', 'canceled', 'duplicate'].includes(status)

export function IssueRelationPicker({ kind, task, open, onOpenChange, pending, onSelect, validationError }: { kind: RelationKind; task: Issue; open: boolean; onOpenChange: (open: boolean) => void; pending: boolean; onSelect: (id: string) => void; validationError?: string }) {
  const { data, error, mutate } = useSWR(open ? ['issue-connections', task.id] : null, () => listIssueConnections(task.id))
  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value) }}><DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg"><DialogHeader className="p-4 pr-10"><DialogTitle>{RELATION_TITLES[kind]}</DialogTitle><DialogDescription>搜索并选择一个你有权访问的任务。不能关联自身或形成循环依赖。</DialogDescription></DialogHeader>{validationError && <p role="alert" className="px-4 pb-3 text-sm text-destructive">{validationError}</p>}<Command className="[&_[cmdk-item]]:min-h-11 lg:[&_[cmdk-item]]:min-h-0"><CommandInput placeholder="搜索标题或任务编号…" aria-label="搜索关联任务" disabled={pending} /><CommandList><CommandEmpty>{error ? '任务读取失败' : data ? '没有可选择的任务' : '正在读取任务…'}</CommandEmpty><CommandGroup heading="可关联的任务">{data?.filter(row => row.id !== task.id && (kind !== 'child' || row.metadata.parentId !== task.id)).map(row => { const Icon = ISSUE_STATUSES.find(status => status.value === row.status)?.icon ?? Circle; return <CommandItem key={row.id} value={`${row.id} ${issueIdentifier(row.metadata.number)} ${row.title}`} disabled={pending} onSelect={() => onSelect(row.id)}><Icon /><span className="shrink-0 text-xs text-muted-foreground">{issueIdentifier(row.metadata.number)}</span><span className="truncate">{row.title}</span></CommandItem> })}{error && <CommandItem onSelect={() => { void mutate() }}>重新读取任务</CommandItem>}</CommandGroup></CommandList></Command></DialogContent></Dialog>
}

export function IssueRelations({ task, mode, onOpen, onCreate, onPick, getCurrent, onSaved, disabled }: { task: Issue; mode: 'subissues' | 'sidebar'; onOpen: (id: string) => void; onCreate: () => void; onPick: (kind: RelationKind) => void; getCurrent: () => Promise<Issue | null>; onSaved: (issue: Issue) => void; disabled: boolean }) {
  const { data: rows, error, mutate } = useSWR(['issue-connections', task.id], () => listIssueConnections(task.id), { refreshInterval: 10000 })
  const [expanded, setExpanded] = useState(true)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const current = rows?.find(row => row.id === task.id)?.metadata ?? task.metadata
  const children = rows?.filter(row => row.metadata.parentId === task.id) ?? []
  async function remove(kind: RelationKind, targetId: string) {
    if (busy.current || disabled) return
    busy.current = true; setPending(true)
    try {
      const latest = await getCurrent()
      if (!latest) return
      const result = await updateIssueRelation({ id: task.id, revision: latest.revision, kind, targetId, remove: true })
      if (!('issue' in result) || !result.issue) throw new Error(result.error)
      onSaved(result.issue); await mutate(); toast.success('任务关系已移除')
    } catch (error) { toast.error(error instanceof Error ? error.message : '移除失败，请重试。') }
    finally { busy.current = false; setPending(false) }
  }
  async function status(id: string, revision: number, status: string) {
    if (busy.current || disabled) return
    busy.current = true; setPending(true)
    try { const result = await moveIssue({ id, revision, status }); if (!('issue' in result) || !result.issue) throw new Error(result.error); await mutate(); toast.success('子任务状态已更新') }
    catch (error) { toast.error(error instanceof Error ? error.message : '状态保存失败。') }
    finally { busy.current = false; setPending(false) }
  }
  if (error) return <Button variant="ghost" size="sm" onClick={() => { void mutate() }}>任务关系读取失败，点击重试</Button>
  if (mode === 'subissues') {
    const done = children.filter(row => closed(row.status)).length
    return <section aria-label="子任务" className="flex flex-col gap-3 py-3 [&_button]:min-h-11 [&_button[aria-label]]:min-w-11 lg:[&_button]:min-h-0 lg:[&_button[aria-label]]:min-w-0">
      <div className="flex items-center justify-between gap-2"><Button variant="ghost" size="xs" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}子任务<span className="text-muted-foreground">{done} / {children.length}</span></Button><div className="flex items-center gap-1"><Button variant="ghost" size="xs" disabled={disabled || pending} onClick={() => onPick('child')}>添加现有任务</Button><Button variant="ghost" size="icon-xs" disabled={disabled || pending} aria-label="创建子任务" onClick={onCreate}><Plus data-icon="inline-start" /></Button></div></div>
      {children.length > 0 && <Progress value={done / children.length * 100} aria-label={`已完成 ${done} 项，共 ${children.length} 项子任务`} className="h-1" />}
      {expanded && children.map(row => <div key={row.id} className="group flex min-w-0 items-center gap-2"><IssuePropertyMenu label={`${row.title} 的状态`} value={row.status} options={ISSUE_STATUSES} icon={Circle} compact disabled={disabled || pending} onChange={value => { void status(row.id, row.revision, value) }} /><Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" onClick={() => onOpen(row.id)}><span className="shrink-0 text-xs text-muted-foreground">{issueIdentifier(row.metadata.number)}</span><span className="truncate">{row.title}</span></Button><Button variant="ghost" size="icon-xs" disabled={disabled || pending} aria-label={`移除子任务关系：${row.title}`} onClick={() => { void remove('child', row.id) }}><X data-icon="inline-start" /></Button></div>)}
      {expanded && children.length === 0 && <Button variant="ghost" size="sm" className="justify-start" disabled={disabled || pending} onClick={onCreate}><Plus data-icon="inline-start" />添加子任务</Button>}
    </section>
  }
  const groups: { kind: RelationKind; label: string; items: NonNullable<typeof rows>; icon: typeof Flag; warning?: boolean }[] = [
    { kind: 'parent', label: '父任务', items: rows?.filter(row => row.id === current.parentId) ?? [], icon: GitBranch },
    { kind: 'blockedBy', label: '被阻塞于', items: rows?.filter(row => current.blockedByIds.includes(row.id) && !closed(row.status)) ?? [], icon: Flag, warning: true },
    { kind: 'blocks', label: '正在阻塞', items: rows?.filter(row => row.metadata.blockedByIds.includes(task.id) && !closed(task.status)) ?? [], icon: Flag, warning: true },
    { kind: 'duplicate', label: '重复于', items: rows?.filter(row => row.id === current.duplicateOfId) ?? [], icon: Link2 },
    { kind: 'related', label: '关联任务', items: rows?.filter(row => current.relatedIds.includes(row.id) || row.metadata.relatedIds.includes(task.id) || (current.blockedByIds.includes(row.id) && closed(row.status)) || (row.metadata.blockedByIds.includes(task.id) && closed(task.status))) ?? [], icon: Link2 },
  ]
  return <>{groups.filter(group => group.items.length).map(group => <section key={group.kind} aria-label={group.label} className="flex min-w-0 flex-col gap-2 [&_button]:min-h-11 [&_button[aria-label]]:min-w-11 lg:[&_button]:min-h-0 lg:[&_button[aria-label]]:min-w-0"><h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><group.icon className={cn('size-3.5', group.warning && 'text-warning-foreground')} />{group.label}</h3>{group.items.map(row => <div key={row.id} className="flex min-w-0 items-center gap-1"><Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" title={row.title} onClick={() => onOpen(row.id)}><span className="shrink-0 text-xs text-muted-foreground">{issueIdentifier(row.metadata.number)}</span><span className="truncate">{row.title}</span></Button><Button variant="ghost" size="icon-xs" disabled={disabled || pending} aria-label={`移除${group.label}：${row.title}`} onClick={() => { void remove(group.kind === 'related' && current.blockedByIds.includes(row.id) ? 'blockedBy' : group.kind === 'related' && row.metadata.blockedByIds.includes(task.id) ? 'blocks' : group.kind, row.id) }}><X data-icon="inline-start" /></Button></div>)}</section>)}</>
}
