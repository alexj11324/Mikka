'use client'

import { useEffect, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, Bell, BellOff, Box, Calendar, Check, Circle, Copy, FileText, Flag, GitBranch, History, Link2, ListPlus, MoreHorizontal, Plus, Signal, Star, Tag, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { createLinkedIssue, setIssueDeleted, toggleIssuePreference, updateIssueRelation } from '@/app/actions/issue-operations'
import { updateIssueMetadata } from '@/app/actions/issue-metadata'
import type { getIssue } from '@/app/actions/issues'
import { useActionError } from '@/lib/use-action-error'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { IssueRelationPicker, relationPickerKey, type RelationKind } from './issue-relations'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier } from './issue-properties'
import type { MetadataRequest } from './issue-metadata-controls'

type Issue = Awaited<ReturnType<typeof getIssue>>
export type IssueActionRequest = { kind: RelationKind | 'createChild' | 'dueDate' | 'estimate'; sequence: number }
type OperationResult = { issue?: Issue; error?: string }

export function IssueDetailActions({ task, userId, disabled, documentTools, request, getCurrent, onSaved, onOpen, onDeleted, onHistory, onMembers, onDocumentTools, onProperty, onStatus, onPriority }: {
  task: Issue; userId: string; disabled: boolean; documentTools: boolean; request: IssueActionRequest | null; getCurrent: () => Promise<Issue | null>; onSaved: (issue: Issue) => void; onOpen: (id: string) => void; onDeleted: () => void; onHistory: () => void; onMembers: () => void; onDocumentTools: () => void; onProperty: (target: MetadataRequest['target']) => void; onStatus: (value: string) => void; onPriority: (value: string) => void
}) {
  const t = useTranslations('IssueDetail')
  const tMenu = useTranslations('IssueDetail.menu')
  const tDialog = useTranslations('IssueDetail.dialog')
  const tIssue = useTranslations('Issue')
  const tMetadata = useTranslations('Metadata.relations')
  const tCommon = useTranslations('Common')
  const tWorkspaceDetail = useTranslations('Workspace.detail')
  const actionError = useActionError()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const relationTitle = (kind: RelationKind) => tMetadata.has(`title.${kind}` as never) ? tMetadata(`title.${kind}` as never) : kind
  const statusOptions = ISSUE_STATUSES.map(item => ({ ...item, label: statusLabel(item.value) }))
  const priorityOptions = ISSUE_PRIORITIES.map(item => ({ ...item, label: priorityLabel(item.value) }))
  const copyItems = [
    { kind: 'link', label: tMenu('copyLink') },
    { kind: 'id', label: tMenu('copyId') },
    { kind: 'title', label: tMenu('copyTitle') },
    { kind: 'markdown', label: tMenu('copyMarkdown') },
    { kind: 'branch', label: tMenu('copyBranch') },
  ] as const
  const { mutate } = useSWRConfig()
  const [relation, setRelation] = useState<RelationKind | null>(null)
  const [dialog, setDialog] = useState<'createChild' | 'duplicate' | 'dueDate' | 'estimate' | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [fieldDefault, setFieldDefault] = useState('')
  const [fieldKey, setFieldKey] = useState(0)
  const fieldRef = useRef<HTMLInputElement>(null)
  const [includeSubissues, setIncludeSubissues] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const [seenRequest, setSeenRequest] = useState<number | null>(null)
  if (request && request.sequence !== seenRequest) {
    setSeenRequest(request.sequence); setError('')
    if (request.kind === 'createChild') { setDialog('createChild'); setFieldDefault(''); setFieldKey(request.sequence) }
    else if (request.kind === 'dueDate' || request.kind === 'estimate') { setDialog(request.kind); setFieldDefault(request.kind === 'dueDate' ? task.metadata.dueDate ?? '' : task.metadata.estimate?.toString() ?? ''); setFieldKey(request.sequence) }
    else setRelation(request.kind)
  }
  function openDialog(kind: NonNullable<typeof dialog>) {
    setError(''); setDialog(kind)
    setFieldDefault(kind === 'dueDate' ? task.metadata.dueDate ?? '' : kind === 'estimate' ? task.metadata.estimate?.toString() ?? '' : kind === 'duplicate' ? t('defaultDuplicateTitle', { title: task.title.slice(0, 195) }) : '')
    setFieldKey(current => current + 1)
  }
  useEffect(() => {
    if (!dialog) return
    const frame = requestAnimationFrame(() => fieldRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [dialog, fieldKey])
  async function run(operation: (issue: Issue) => Promise<OperationResult>, mode: 'current' | 'child' | 'duplicate' | 'delete' | 'favorite' | 'unfavorite' = 'current') {
    if (busy.current || disabled) return false
    busy.current = true; setPending(true); setError('')
    try {
      const latest = await getCurrent()
      if (!latest) throw new Error(t('saveCurrentFirst'))
      const result = await operation(latest)
      if (!result.issue) throw new Error(actionError(result.error ?? 'generic'))
      if (mode === 'current') onSaved(result.issue)
      await Promise.all([mutate(['issue-connections', task.id]), mutate(['issues', task.userId]), mutate(relationPickerKey(task.userId))])
      if (mode === 'duplicate') onOpen(result.issue.id)
      if (mode === 'delete') {
        onDeleted()
        toast.success(t('taskDeleted'), { description: t('taskDeletedDescription'), action: { label: t('undo'), onClick: () => { void setIssueDeleted({ id: task.id, restore: true }).then(async response => { if (response.error) toast.error(actionError(response.error)); else { await mutate(['issues', task.userId]); onOpen(task.id) } }).catch(() => toast.error(t('restoreViaLinkFailed'))) } } })
      } else toast.success(mode === 'child' ? t('childCreated') : mode === 'duplicate' ? t('duplicateCreated') : mode === 'favorite' ? t('favorited') : mode === 'unfavorite' ? t('unfavorited') : t('taskUpdated'))
      return true
    } catch (error) { const message = error instanceof Error ? error.message : t('operationFailed'); setError(message); toast.error(message); return false }
    finally { busy.current = false; setPending(false) }
  }
  async function copy(kind: 'link' | 'id' | 'title' | 'markdown' | 'branch') {
    try {
      const url = new URL(window.location.href); url.search = ''; url.searchParams.set('issue', task.id)
      const identifier = issueIdentifier(task.metadata.number)
      const text = kind === 'link' ? url.href : kind === 'id' ? identifier : kind === 'title' ? `${identifier} ${task.title}` : kind === 'branch' ? `${identifier.toLowerCase()}/${task.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60)}` : `[${identifier} ${task.title.replace(/[[\]\\]/g, '\\$&')}](${url.href})`
      await navigator.clipboard.writeText(text); toast.success(t('copySuccess'))
    } catch { toast.error(t('copyFailed')) }
  }
  const [favoriteOverride, setFavoriteOverride] = useState<boolean | null>(null)
  useEffect(() => { setFavoriteOverride(null) }, [task.revision])
  const favorite = favoriteOverride ?? task.metadata.favoriteUserIds.includes(userId)
  async function toggleFavorite() {
    const next = !favorite
    setFavoriteOverride(next)
    const ok = await run(() => toggleIssuePreference({ id: task.id, kind: 'favorite' }), next ? 'favorite' : 'unfavorite')
    if (!ok) setFavoriteOverride(null)
  }
  const subscribed = task.metadata.subscriberUserIds.includes(userId)
  const unavailable = disabled || pending
  return <>
    <Button variant="ghost" size="icon-sm" aria-label={favorite ? tMenu('unfavorite') : tMenu('favorite')} aria-pressed={favorite} disabled={unavailable} onClick={() => { void toggleFavorite() }}><Star data-icon="inline-start" fill={favorite ? 'currentColor' : 'none'} /></Button>
    <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={tWorkspaceDetail('moreActions')} disabled={unavailable} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-h-[min(80svh,720px)] w-64 overflow-y-auto">
      <DropdownMenuGroup>
        <DropdownMenuSub><DropdownMenuSubTrigger><Circle />{tMenu('setStatus')}</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{statusOptions.map(status => <DropdownMenuItem key={status.value} onClick={() => onStatus(status.value)}><status.icon /><span className="flex-1">{status.label}</span>{task.status === status.value && <Check />}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
        <DropdownMenuSub><DropdownMenuSubTrigger><Signal />{tMenu('setPriority')}</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{priorityOptions.map(priority => <DropdownMenuItem key={priority.value} onClick={() => onPriority(priority.value)}><priority.icon {...priority.iconProps} /><span className="flex-1">{priority.label}</span>{task.priority === priority.value && <Check />}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
        <DropdownMenuItem onClick={() => onProperty('assignee')}><Users />{tMenu('assignAssignee')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onProperty('project')}><Box />{tMenu('moveToProject')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onProperty('labels')}><Tag />{tMenu('editLabels')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openDialog('dueDate')}><Calendar />{task.metadata.dueDate ? tMenu('editDueDate') : tMenu('setDueDate')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openDialog('estimate')}><Signal />{tMenu('setEstimate')}</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => openDialog('createChild')}><Plus />{tMenu('createChild')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setError(''); setRelation('child') }}><ListPlus />{tMenu('addExistingChild')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setError(''); setRelation('parent') }}><GitBranch />{tMenu('setParent')}</DropdownMenuItem>
        {task.metadata.parentId && <DropdownMenuItem onClick={() => { void run(issue => updateIssueRelation({ id: task.id, revision: issue.revision, targetId: null, kind: 'parent', remove: true })) }}><X />{tMenu('removeParent')}</DropdownMenuItem>}
        <DropdownMenuSub><DropdownMenuSubTrigger><Link2 />{tMenu('addRelation')}</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{(['related', 'blockedBy', 'blocks', 'duplicate'] as RelationKind[]).map(kind => <DropdownMenuItem key={kind} onClick={() => { setError(''); setRelation(kind) }}>{kind === 'blocks' || kind === 'blockedBy' ? <Flag /> : <Link2 />}{relationTitle(kind)}…</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuSub><DropdownMenuSubTrigger><Copy />{tMenu('copy')}</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{copyItems.map(item => <DropdownMenuItem key={item.kind} onClick={() => { void copy(item.kind) }}>{item.label}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
        <DropdownMenuItem onClick={() => { const url = new URL(window.location.href); url.search = ''; url.searchParams.set('issue', task.id); window.open(url.href, '_blank', 'noopener,noreferrer') }}><ArrowUpRight />{tMenu('openNewTab')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openDialog('duplicate')}><Copy />{tMenu('createDuplicate')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { void toggleFavorite() }}><Star />{favorite ? tMenu('removeFavorite') : tMenu('addFavorite')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { void run(() => toggleIssuePreference({ id: task.id, kind: 'subscribe' })) }}>{subscribed ? <BellOff /> : <Bell />}{subscribed ? tMenu('unsubscribe') : tMenu('subscribe')}</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={onHistory}><History />{tMenu('showHistory')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onProperty('pullRequests')}><Link2 />{tMenu('managePullRequests')}</DropdownMenuItem>
        <DropdownMenuItem onClick={onMembers}><Users />{tMenu('manageMembers')}</DropdownMenuItem>
        <DropdownMenuItem onClick={onDocumentTools}><FileText />{documentTools ? tMenu('backToDescription') : tWorkspaceDetail('advancedTools')}</DropdownMenuItem>
      </DropdownMenuGroup>
      {task.userId === userId && <><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuItem variant="destructive" onClick={() => { setError(''); setDeleteOpen(true) }}><Trash2 />{tMenu('deleteTask')}</DropdownMenuItem></DropdownMenuGroup></>}
    </DropdownMenuContent></DropdownMenu>
    {relation && <IssueRelationPicker task={task} kind={relation} validationError={error} open onOpenChange={open => { if (!open) setRelation(null) }} pending={pending} onSelect={targetId => { void run(issue => updateIssueRelation({ id: task.id, revision: issue.revision, kind: relation, targetId })).then(success => { if (success) setRelation(null) }) }} />}
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !pending) setDialog(null) }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{dialog === 'createChild' ? tDialog('createChildTitle') : dialog === 'duplicate' ? tDialog('duplicateTitle') : dialog === 'dueDate' ? tDialog('dueDateTitle') : tDialog('estimateTitle')}</DialogTitle><DialogDescription>{dialog === 'createChild' ? tDialog('createChildDescription') : dialog === 'duplicate' ? tDialog('duplicateDescription') : tDialog('attributeDescription')}</DialogDescription></DialogHeader><form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); const kind = dialog; if (!kind) return; const entered = fieldRef.current?.value ?? ''; void run(issue => kind === 'createChild' || kind === 'duplicate' ? createLinkedIssue({ id: task.id, revision: issue.revision, kind: kind === 'createChild' ? 'child' : 'duplicate', title: entered, includeSubissues: kind === 'duplicate' && includeSubissues }) : updateIssueMetadata({ id: task.id, revision: issue.revision, patch: kind === 'dueDate' ? { dueDate: entered || null } : { estimate: entered === '' ? null : Number(entered) } }), kind === 'createChild' ? 'child' : kind === 'duplicate' ? 'duplicate' : 'current').then(success => { if (success) setDialog(null) }) }}><FieldGroup><Field><FieldLabel htmlFor="issue-action-value">{dialog === 'dueDate' ? tDialog('dueDateLabel') : dialog === 'estimate' ? tDialog('estimateLabel') : tDialog('taskTitleLabel')}</FieldLabel><Input ref={fieldRef} key={fieldKey} id="issue-action-value" autoFocus type={dialog === 'dueDate' ? 'date' : dialog === 'estimate' ? 'number' : 'text'} min={dialog === 'estimate' ? 0 : undefined} max={dialog === 'estimate' ? 100 : undefined} step={dialog === 'estimate' ? 1 : undefined} defaultValue={fieldDefault} disabled={pending} required={dialog === 'createChild' || dialog === 'duplicate'} maxLength={200} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault() }} /></Field>{dialog === 'duplicate' && <Field orientation="horizontal"><Checkbox id="duplicate-subissues" checked={includeSubissues} onCheckedChange={checked => setIncludeSubissues(!!checked)} /><FieldLabel htmlFor="duplicate-subissues">{tDialog('duplicateSubissues')}</FieldLabel></Field>}</FieldGroup>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="ghost" disabled={pending} onClick={() => setDialog(null)}>{tCommon('cancel')}</Button><Button type="submit" disabled={pending}>{pending ? tCommon('saving') : dialog === 'createChild' || dialog === 'duplicate' ? tIssue('create.submit') : tCommon('save')}</Button></DialogFooter></form></DialogContent></Dialog>
    <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{tDialog('deleteTitle', { id: issueIdentifier(task.metadata.number) })}</AlertDialogTitle><AlertDialogDescription>{tDialog('deleteDescription')}</AlertDialogDescription></AlertDialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<AlertDialogFooter><AlertDialogCancel disabled={pending}>{tCommon('cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={event => { event.preventDefault(); void run(issue => setIssueDeleted({ id: task.id, revision: issue.revision }), 'delete').then(success => { if (success) setDeleteOpen(false) }) }}>{pending ? tDialog('deleting') : tDialog('deleteAction')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}
