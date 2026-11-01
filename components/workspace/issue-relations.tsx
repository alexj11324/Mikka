'use client'

import { useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, Circle, Flag, GitBranch, Link2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { listIssueConnections, updateIssueRelation } from '@/app/actions/issue-operations'
import { moveIssue, type IssueView } from '@/app/actions/issues'
import { useActionError } from '@/lib/use-action-error'
import { useRelationSearch } from '@/lib/hooks/use-relation-search'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { ISSUE_STATUSES, issueIdentifier } from './issue-properties'
import { IssuePropertyMenu } from './issue-property-menu'
import { cn } from '@/lib/utils'
import { FieldError } from '@/components/ui/field'

type Issue = IssueView
export type RelationKind = 'parent' | 'child' | 'related' | 'blockedBy' | 'blocks' | 'duplicate'
const closed = (status: string) => ['done', 'canceled', 'duplicate'].includes(status)

export function IssueRelationPicker({ kind, task, open, onOpenChange, pending, onSelect, validationError }: { kind: RelationKind; task: Issue; open: boolean; onOpenChange: (open: boolean) => void; pending: boolean; onSelect: (id: string) => void; validationError?: string }) {
  const t = useTranslations('Metadata.relations')
  const relationTitle = (value: RelationKind) => t.has(`title.${value}` as never) ? t(`title.${value}` as never) : value
  const [query, setQuery] = useState('')
  // The server excludes the task itself, a parent's descendants and a sub-issue's ancestors, and reports canRelate per row.
  const { items, rows, failed, reload } = useRelationSearch({ open, issueId: task.id, kind, query })
  const needle = query.trim()
  const loadFailed = failed && !items
  // On load failure the error is an alert above the Command (cmdk hides CommandEmpty when an item exists); the list keeps only the reload item.
  const empty = loadFailed ? '' : !items ? t('loading') : rows.length === 0 && !needle && items.some(item => !item.canRelate) ? t('noTasksSameOwner') : rows.length === 0 ? t(needle ? 'noMatch' : 'noTasks') : ''
  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value) }}><DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">{/* Our own container caps the height to the viewport so the header and close button stay visible on short screens; the list scrolls inside. */}<div className="flex max-h-[calc(100svh-2rem)] min-h-0 flex-col"><DialogHeader className="shrink-0 p-4 pr-10"><DialogTitle>{relationTitle(kind)}</DialogTitle></DialogHeader>{validationError && <FieldError className="shrink-0 px-4 pb-3">{validationError}</FieldError>}{loadFailed && <FieldError className="shrink-0 px-4 pb-3">{t('loadFailed')}</FieldError>}<Command shouldFilter={false} className="min-h-0 flex-1 [&_[cmdk-item]]:min-h-11 lg:[&_[cmdk-item]]:min-h-0"><CommandInput value={query} onValueChange={setQuery} placeholder={t('searchPlaceholder')} aria-label={t('searchAria')} disabled={pending} />{/* min-h keeps loading / empty / list states the same height so the dialog does not jump. */}<CommandList className="min-h-36">{empty ? <CommandEmpty>{!items ? <span className="text-muted-foreground">{empty}</span> : empty}</CommandEmpty> : null}{rows.length > 0 && <CommandGroup heading={t('group')}>{rows.map(row => { const Icon = ISSUE_STATUSES.find(status => status.value === row.status)?.icon ?? Circle; return <CommandItem key={row.id} value={`${row.id} ${issueIdentifier(row)} ${row.title}`} disabled={pending} onSelect={() => onSelect(row.id)}><Icon /><span className="shrink-0 text-xs text-muted-foreground">{issueIdentifier(row)}</span><span className="truncate">{row.title}</span></CommandItem> })}</CommandGroup>}{failed && <CommandGroup><CommandItem value="reload" onSelect={reload}>{t('reload')}</CommandItem></CommandGroup>}</CommandList></Command></div></DialogContent></Dialog>
}

export function IssueRelations({ viewerId, task, mode, onOpen, onCreate, onPick, getCurrent, onSaved, disabled }: { viewerId: string; task: Issue; mode: 'subissues' | 'sidebar'; onOpen: (id: string) => void; onCreate: () => void; onPick: (kind: RelationKind) => void; getCurrent: () => Promise<Issue | null>; onSaved: (issue: Issue) => void; disabled: boolean }) {
  const t = useTranslations('Metadata.relations')
  const tIssue = useTranslations('Issue')
  const actionError = useActionError()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const groupLabel = (value: RelationKind) => t.has(`groupLabel.${value}` as never) ? t(`groupLabel.${value}` as never) : value
  const statusOptions = ISSUE_STATUSES.map(item => ({ ...item, label: statusLabel(item.value) }))
  const { mutate: refresh } = useSWRConfig()
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
      if (!('issue' in result) || !result.issue) throw new Error(actionError(result.error))
      onSaved(result.issue); await Promise.all([mutate(), refresh(['issues', viewerId])]); toast.success(t('removed'))
    } catch (error) { toast.error(error instanceof Error ? error.message : t('removeFailed')) }
    finally { busy.current = false; setPending(false) }
  }
  async function status(id: string, revision: number, status: string) {
    if (busy.current || disabled) return
    busy.current = true; setPending(true)
    try { const result = await moveIssue({ id, revision, status }); if (!('issue' in result) || !result.issue) throw new Error(actionError(result.error)); await mutate(); toast.success(t('childStatusUpdated')) }
    catch (error) { toast.error(error instanceof Error ? error.message : t('statusSaveFailed')) }
    finally { busy.current = false; setPending(false) }
  }
  if (error) return <Button variant="ghost" size="sm" onClick={() => { void mutate() }}>{t('readFailedRetry')}</Button>
  if (mode === 'subissues') {
    const done = children.filter(row => closed(row.status)).length
    // Empty: one way in (R-40). 添加现有子任务 stays in the task's ⋯ menu; the header and count arrive with the first sub-task.
    if (children.length === 0) return <section aria-label={t('subissuesAria')} className="mt-2 flex [&_button]:min-h-11 lg:[&_button]:min-h-0">
      <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" disabled={disabled || pending} onClick={onCreate}><Plus data-icon="inline-start" />{t('addChild')}</Button>
    </section>
    return <section aria-label={t('subissuesAria')} className="mt-2 flex flex-col gap-3 rounded-lg bg-muted/30 px-3 py-4 [&_button]:min-h-11 [&_button[aria-label]]:min-w-11 lg:[&_button]:min-h-0 lg:[&_button[aria-label]]:min-w-0">
      <div className="flex items-center justify-between gap-2"><Button variant="ghost" size="xs" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}{t('subissues')}<span className="text-muted-foreground">{done} / {children.length}</span></Button><div className="flex items-center gap-1"><Button variant="ghost" size="xs" disabled={disabled || pending} onClick={() => onPick('child')}>{t('addExisting')}</Button><Button variant="ghost" size="icon-xs" disabled={disabled || pending} aria-label={t('createChildAria')} onClick={onCreate}><Plus data-icon="inline-start" /></Button></div></div>
      <Progress value={done / children.length * 100} aria-label={t('progressAria', { done, total: children.length })} className="h-1" />
      {expanded && children.map(row => <div key={row.id} className="group flex min-w-0 items-center gap-2 rounded-md transition-colors hover:bg-muted"><IssuePropertyMenu label={t('statusOf', { title: row.title })} value={row.status} options={statusOptions} icon={Circle} compact disabled={disabled || pending} onChange={value => { void status(row.id, row.revision, value) }} /><Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start hover:bg-transparent dark:hover:bg-transparent" onClick={() => onOpen(row.id)}><span className="shrink-0 text-xs text-muted-foreground">{issueIdentifier(row)}</span><span className="truncate">{row.title}</span></Button><Button variant="ghost" size="icon-xs" disabled={disabled || pending} aria-label={t('removeChildAria', { title: row.title })} onClick={() => { void remove('child', row.id) }}><X data-icon="inline-start" /></Button></div>)}
    </section>
  }
  const groups: { kind: RelationKind; label: string; items: NonNullable<typeof rows>; icon: typeof Flag; warning?: boolean }[] = [
    { kind: 'parent', label: groupLabel('parent'), items: rows?.filter(row => row.id === current.parentId) ?? [], icon: GitBranch },
    { kind: 'blockedBy', label: groupLabel('blockedBy'), items: rows?.filter(row => current.blockedByIds.includes(row.id) && !closed(row.status)) ?? [], icon: Flag, warning: true },
    { kind: 'blocks', label: groupLabel('blocks'), items: rows?.filter(row => row.metadata.blockedByIds.includes(task.id) && !closed(task.status)) ?? [], icon: Flag, warning: true },
    { kind: 'duplicate', label: groupLabel('duplicate'), items: rows?.filter(row => row.id === current.duplicateOfId) ?? [], icon: Link2 },
    { kind: 'related', label: groupLabel('related'), items: rows?.filter(row => current.relatedIds.includes(row.id) || row.metadata.relatedIds.includes(task.id) || (current.blockedByIds.includes(row.id) && closed(row.status)) || (row.metadata.blockedByIds.includes(task.id) && closed(task.status))) ?? [], icon: Link2 },
  ]
  return <>{groups.filter(group => group.items.length).map(group => <section key={group.kind} aria-label={group.label} className="flex min-w-0 flex-col gap-2 [&_button]:min-h-11 [&_button[aria-label]]:min-w-11 lg:[&_button]:min-h-0 lg:[&_button[aria-label]]:min-w-0"><h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><group.icon className={cn('size-3.5', group.warning && 'text-warning-foreground')} />{group.label}</h3>{group.items.map(row => <div key={row.id} className="flex min-w-0 items-center gap-1 rounded-md transition-colors hover:bg-muted"><Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start hover:bg-transparent dark:hover:bg-transparent" title={row.title} onClick={() => onOpen(row.id)}><span className="shrink-0 text-xs text-muted-foreground">{issueIdentifier(row)}</span><span className="truncate">{row.title}</span></Button><Button variant="ghost" size="icon-xs" disabled={disabled || pending} aria-label={t('removeAria', { label: group.label, title: row.title })} onClick={() => { void remove(group.kind === 'related' && current.blockedByIds.includes(row.id) ? 'blockedBy' : group.kind === 'related' && row.metadata.blockedByIds.includes(task.id) ? 'blocks' : group.kind, row.id) }}><X data-icon="inline-start" /></Button></div>)}</section>)}</>
}
