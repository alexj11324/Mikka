'use client'

import { useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { ArrowUpRight, Bell, BellOff, Box, Calendar, Check, Circle, Copy, FileText, Flag, GitBranch, History, Link2, ListPlus, MoreHorizontal, Plus, Signal, Star, Tag, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { createLinkedIssue, setIssueDeleted, toggleIssuePreference, updateIssueRelation } from '@/app/actions/issue-operations'
import { updateIssueMetadata } from '@/app/actions/issue-metadata'
import type { getIssue } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { IssueRelationPicker, RELATION_TITLES, type RelationKind } from './issue-relations'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier } from './issue-properties'
import type { MetadataRequest } from './issue-metadata-controls'

type Issue = Awaited<ReturnType<typeof getIssue>>
export type IssueActionRequest = { kind: RelationKind | 'createChild' | 'dueDate' | 'estimate'; sequence: number }
type OperationResult = { issue?: Issue; error?: string }

export function IssueDetailActions({ task, userId, disabled, documentTools, request, getCurrent, onSaved, onOpen, onClose, onHistory, onMembers, onDocumentTools, onProperty, onStatus, onPriority }: {
  task: Issue; userId: string; disabled: boolean; documentTools: boolean; request: IssueActionRequest | null; getCurrent: () => Promise<Issue | null>; onSaved: (issue: Issue) => void; onOpen: (id: string) => void; onClose: () => void; onHistory: () => void; onMembers: () => void; onDocumentTools: () => void; onProperty: (target: MetadataRequest['target']) => void; onStatus: (value: string) => void; onPriority: (value: string) => void
}) {
  const { mutate } = useSWRConfig()
  const [relation, setRelation] = useState<RelationKind | null>(null)
  const [dialog, setDialog] = useState<'createChild' | 'duplicate' | 'dueDate' | 'estimate' | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [value, setValue] = useState('')
  const [includeSubissues, setIncludeSubissues] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const [seenRequest, setSeenRequest] = useState<number | null>(null)
  if (request && request.sequence !== seenRequest) {
    setSeenRequest(request.sequence); setError('')
    if (request.kind === 'createChild') { setDialog('createChild'); setValue('') }
    else if (request.kind === 'dueDate' || request.kind === 'estimate') { setDialog(request.kind); setValue(request.kind === 'dueDate' ? task.metadata.dueDate ?? '' : task.metadata.estimate?.toString() ?? '') }
    else setRelation(request.kind)
  }
  function openDialog(kind: NonNullable<typeof dialog>) {
    setError(''); setDialog(kind)
    setValue(kind === 'dueDate' ? task.metadata.dueDate ?? '' : kind === 'estimate' ? task.metadata.estimate?.toString() ?? '' : kind === 'duplicate' ? `${task.title.slice(0, 195)}（副本）` : '')
  }
  async function run(operation: (issue: Issue) => Promise<OperationResult>, mode: 'current' | 'child' | 'duplicate' | 'delete' = 'current') {
    if (busy.current || disabled) return false
    busy.current = true; setPending(true); setError('')
    try {
      const latest = await getCurrent()
      if (!latest) throw new Error('请先完成当前修改的保存。')
      const result = await operation(latest)
      if (!result.issue) throw new Error(result.error ?? '操作未成功，请重试。')
      if (mode === 'current') onSaved(result.issue)
      await Promise.all([mutate(['issue-connections', task.id]), mutate('issues')])
      if (mode === 'duplicate') onOpen(result.issue.id)
      if (mode === 'delete') {
        onClose()
        toast.success('任务已删除', { description: '任务内容保留 30 天，可通过原链接恢复。', action: { label: '撤销', onClick: () => { void setIssueDeleted({ id: task.id, restore: true }).then(async response => { if (response.error) toast.error(response.error); else { await mutate('issues'); onOpen(task.id) } }).catch(() => toast.error('恢复失败，请通过原任务链接重试。')) } } })
      } else toast.success(mode === 'child' ? '子任务已创建' : mode === 'duplicate' ? '任务副本已创建' : '任务已更新')
      return true
    } catch (error) { const message = error instanceof Error ? error.message : '操作失败，请重试。'; setError(message); toast.error(message); return false }
    finally { busy.current = false; setPending(false) }
  }
  async function copy(kind: 'link' | 'id' | 'title' | 'markdown' | 'branch') {
    try {
      const url = new URL(window.location.href); url.search = ''; url.searchParams.set('issue', task.id)
      const identifier = issueIdentifier(task.metadata.number)
      const text = kind === 'link' ? url.href : kind === 'id' ? identifier : kind === 'title' ? `${identifier} ${task.title}` : kind === 'branch' ? `${identifier.toLowerCase()}/${task.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60)}` : `[${identifier} ${task.title.replace(/[[\]\\]/g, '\\$&')}](${url.href})`
      await navigator.clipboard.writeText(text); toast.success('已复制到剪贴板')
    } catch { toast.error('复制失败，请允许浏览器访问剪贴板。') }
  }
  const favorite = task.metadata.favoriteUserIds.includes(userId)
  const subscribed = task.metadata.subscriberUserIds.includes(userId)
  const unavailable = disabled || pending
  return <>
    <Button variant="ghost" size="icon-sm" aria-label={favorite ? '取消收藏任务' : '收藏任务'} aria-pressed={favorite} disabled={unavailable} onClick={() => { void run(() => toggleIssuePreference({ id: task.id, kind: 'favorite' })) }}><Star data-icon="inline-start" fill={favorite ? 'currentColor' : 'none'} /></Button>
    <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="更多任务操作" disabled={unavailable} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-h-[min(80svh,720px)] w-64 overflow-y-auto">
      <DropdownMenuGroup>
        <DropdownMenuSub><DropdownMenuSubTrigger><Circle />设置状态</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{ISSUE_STATUSES.map(status => <DropdownMenuItem key={status.value} onClick={() => onStatus(status.value)}><status.icon /><span className="flex-1">{status.label}</span>{task.status === status.value && <Check />}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
        <DropdownMenuSub><DropdownMenuSubTrigger><Signal />设置优先级</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{ISSUE_PRIORITIES.map(priority => <DropdownMenuItem key={priority.value} onClick={() => onPriority(priority.value)}><priority.icon {...priority.iconProps} /><span className="flex-1">{priority.label}</span>{task.priority === priority.value && <Check />}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
        <DropdownMenuItem onClick={() => onProperty('assignee')}><Users />分配负责人…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onProperty('project')}><Box />移动到项目…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onProperty('labels')}><Tag />添加或移除标签…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openDialog('dueDate')}><Calendar />{task.metadata.dueDate ? '修改截止日期…' : '设置截止日期…'}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openDialog('estimate')}><Signal />设置工作量估算…</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => openDialog('createChild')}><Plus />创建子任务…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setError(''); setRelation('child') }}><ListPlus />添加现有子任务…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setError(''); setRelation('parent') }}><GitBranch />设置父任务…</DropdownMenuItem>
        {task.metadata.parentId && <DropdownMenuItem onClick={() => { void run(issue => updateIssueRelation({ id: task.id, revision: issue.revision, targetId: null, kind: 'parent', remove: true })) }}><X />移除父任务</DropdownMenuItem>}
        <DropdownMenuSub><DropdownMenuSubTrigger><Link2 />添加任务关系</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{(['related', 'blockedBy', 'blocks', 'duplicate'] as RelationKind[]).map(kind => <DropdownMenuItem key={kind} onClick={() => { setError(''); setRelation(kind) }}>{kind === 'blocks' || kind === 'blockedBy' ? <Flag /> : <Link2 />}{RELATION_TITLES[kind]}…</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuSub><DropdownMenuSubTrigger><Copy />复制</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{([{ kind: 'link', label: '复制任务链接' }, { kind: 'id', label: '复制任务编号' }, { kind: 'title', label: '复制编号与标题' }, { kind: 'markdown', label: '复制 Markdown 链接' }, { kind: 'branch', label: '复制 Git 分支名称' }] as const).map(item => <DropdownMenuItem key={item.kind} onClick={() => { void copy(item.kind) }}>{item.label}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
        <DropdownMenuItem onClick={() => { const url = new URL(window.location.href); url.search = ''; url.searchParams.set('issue', task.id); window.open(url.href, '_blank', 'noopener,noreferrer') }}><ArrowUpRight />在新标签页中打开</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openDialog('duplicate')}><Copy />创建任务副本…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { void run(() => toggleIssuePreference({ id: task.id, kind: 'favorite' })) }}><Star />{favorite ? '取消收藏' : '添加到收藏'}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { void run(() => toggleIssuePreference({ id: task.id, kind: 'subscribe' })) }}>{subscribed ? <BellOff /> : <Bell />}{subscribed ? '取消关注任务' : '关注任务活动'}</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={onHistory}><History />显示描述历史…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onProperty('pullRequests')}><Link2 />管理关联 PR…</DropdownMenuItem>
        <DropdownMenuItem onClick={onMembers}><Users />管理协作成员…</DropdownMenuItem>
        <DropdownMenuItem onClick={onDocumentTools}><FileText />{documentTools ? '返回任务描述' : '高级文档工具'}</DropdownMenuItem>
      </DropdownMenuGroup>
      {task.userId === userId && <><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuItem variant="destructive" onClick={() => { setError(''); setDeleteOpen(true) }}><Trash2 />删除任务…</DropdownMenuItem></DropdownMenuGroup></>}
    </DropdownMenuContent></DropdownMenu>
    {relation && <IssueRelationPicker task={task} kind={relation} open onOpenChange={open => { if (!open) setRelation(null) }} pending={pending} onSelect={targetId => { void run(issue => updateIssueRelation({ id: task.id, revision: issue.revision, kind: relation, targetId })).then(success => { if (success) setRelation(null) }) }} />}
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !pending) setDialog(null) }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{dialog === 'createChild' ? '创建子任务' : dialog === 'duplicate' ? '创建任务副本' : dialog === 'dueDate' ? '设置截止日期' : '设置工作量估算'}</DialogTitle><DialogDescription>{dialog === 'createChild' ? '继承父任务的优先级、项目和访问成员。' : dialog === 'duplicate' ? '创建独立副本，不复制讨论、关注者或阻塞关系。' : '修改将保存到任务属性；留空可以移除此属性。'}</DialogDescription></DialogHeader><form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); const kind = dialog; if (!kind) return; void run(issue => kind === 'createChild' || kind === 'duplicate' ? createLinkedIssue({ id: task.id, revision: issue.revision, kind: kind === 'createChild' ? 'child' : 'duplicate', title: value, includeSubissues: kind === 'duplicate' && includeSubissues }) : updateIssueMetadata({ id: task.id, revision: issue.revision, patch: kind === 'dueDate' ? { dueDate: value || null } : { estimate: value === '' ? null : Number(value) } }), kind === 'createChild' ? 'child' : kind === 'duplicate' ? 'duplicate' : 'current').then(success => { if (success) setDialog(null) }) }}><FieldGroup><Field><FieldLabel htmlFor="issue-action-value">{dialog === 'dueDate' ? '截止日期' : dialog === 'estimate' ? '估算点数（0–100）' : '任务标题'}</FieldLabel><Input id="issue-action-value" autoFocus type={dialog === 'dueDate' ? 'date' : dialog === 'estimate' ? 'number' : 'text'} min={dialog === 'estimate' ? 0 : undefined} max={dialog === 'estimate' ? 100 : undefined} step={dialog === 'estimate' ? 1 : undefined} value={value} onChange={event => setValue(event.target.value)} disabled={pending} required={dialog === 'createChild' || dialog === 'duplicate'} maxLength={200} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault() }} /></Field>{dialog === 'duplicate' && <Field orientation="horizontal"><Checkbox id="duplicate-subissues" checked={includeSubissues} onCheckedChange={checked => setIncludeSubissues(!!checked)} /><FieldLabel htmlFor="duplicate-subissues">同时复制可访问的子任务</FieldLabel></Field>}</FieldGroup>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="ghost" disabled={pending} onClick={() => setDialog(null)}>取消</Button><Button type="submit" disabled={pending}>{pending ? '正在保存…' : dialog === 'createChild' || dialog === 'duplicate' ? '创建任务' : '保存'}</Button></DialogFooter></form></DialogContent></Dialog>
    <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除 {issueIdentifier(task.metadata.number)}？</AlertDialogTitle><AlertDialogDescription>任务将从列表和看板移除，但不会立即清除正文、评论或子任务。30 天内可以通过原链接恢复。</AlertDialogDescription></AlertDialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<AlertDialogFooter><AlertDialogCancel disabled={pending}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={event => { event.preventDefault(); void run(issue => setIssueDeleted({ id: task.id, revision: issue.revision }), 'delete').then(success => { if (success) setDeleteOpen(false) }) }}>{pending ? '正在删除…' : '删除任务'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}
