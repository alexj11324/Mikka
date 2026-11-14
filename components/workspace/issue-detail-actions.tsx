'use client'

import { issueKeys } from '@/lib/swr/keys'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { createLinkedIssue, setIssueDeleted, toggleIssuePreference, updateIssueRelation } from '@/app/actions/issue-operations'
import { updateIssueMetadata } from '@/app/actions/issue-metadata'
import type { IssueView } from '@/app/actions/issues'
import { useActionError } from '@/lib/use-action-error'
import { isIssueListKey } from '@/lib/live/list-read'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { IssueRelationPicker, type RelationKind } from './issue-relations'
import { workspaceSearch } from './workspace-navigation'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier } from './issue-properties'
import type { MetadataRequest } from './issue-metadata-controls'
import type { TaskMenuItem } from '@/components/slots/task-detail-contract'

type Issue = IssueView
export type IssueActionRequest = { kind: RelationKind | 'createChild' | 'dueDate' | 'estimate'; sequence: number }
type OperationResult = { issue?: Issue; error?: string }

type ActionsProps = {
  task: Issue; userId: string; disabled: boolean; canCreateChild: boolean; documentTools: boolean; request: IssueActionRequest | null; getCurrent: () => Promise<Issue | null>; onSaved: (issue: Issue) => void; onOpen: (id: string) => void; onDeleted: () => void; onHistory: () => void; onMembers: () => void; onDocumentTools: () => void; onProperty: (target: MetadataRequest['target']) => void; onStatus: (value: string) => void; onPriority: (value: string) => void
}

export function useIssueDetailActions({ task, userId, disabled, canCreateChild, request, getCurrent, onSaved, onOpen, onDeleted }: ActionsProps) {
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
  const copyItems = ([
    { kind: 'link', label: tMenu('copyLink') },
    { kind: 'id', label: tMenu('copyId') },
    { kind: 'title', label: tMenu('copyTitle') },
    { kind: 'markdown', label: tMenu('copyMarkdown') },
    { kind: 'branch', label: tMenu('copyBranch') },
  ] as const).filter(item => item.kind !== 'id' || task.identifier)
  const { mutate } = useSWRConfig()
  const [relation, setRelation] = useState<RelationKind | null>(null)
  const queuedRelation = useRef<RelationKind | null>(null)
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
      if (!result.issue) {
        if (result.error === 'issueOutdated') {
          const refreshed = await mutate<Issue>(issueKeys.detail(task.id))
          if (refreshed?.id === latest.id && refreshed.revision > latest.revision) {
            throw new Error(actionError('issueStale'))
          }
        }
        throw new Error(actionError(result.error ?? 'generic'))
      }
      const updatesCurrent = mode === 'current' || mode === 'favorite' || mode === 'unfavorite'
      if (updatesCurrent) onSaved(result.issue)
      // A deleted task can no longer serve its connections. Its surrounding list still needs the ACK.
      await Promise.all([
        mode === 'delete' ? undefined : mutate(issueKeys.connections(task.id)),
        updatesCurrent ? undefined : mutate(key => isIssueListKey(key, userId)),
      ])
      if (mode === 'duplicate') onOpen(result.issue.id)
      if (mode === 'delete') {
        onDeleted()
        toast.success(t('taskDeleted'), { action: { label: t('undo'), onClick: () => { void setIssueDeleted({ id: task.id, restore: true }).then(async response => { if (response.error) toast.error(actionError(response.error)); else { await mutate(key => isIssueListKey(key, userId)); onOpen(task.id) } }).catch(() => toast.error(t('restoreViaLinkFailed'))) } } })
      } else toast.success(mode === 'child' ? t('childCreated') : mode === 'duplicate' ? t('duplicateCreated') : mode === 'favorite' ? t('favorited') : mode === 'unfavorite' ? t('unfavorited') : t('taskUpdated'))
      return true
    } catch (error) { const message = error instanceof Error ? error.message : t('operationFailed'); setError(message); toast.error(message); return false }
    finally { busy.current = false; setPending(false) }
  }
  async function createChild(title: string) {
    if (!canCreateChild || !title.trim()) return false
    return run(issue => createLinkedIssue({ id: issue.id, revision: issue.revision, kind: 'child', title: title.trim(), includeSubissues: false }), 'child')
  }
  async function submitDialog(entered: string) {
    if (!dialog) return
    let saved: boolean
    if (dialog === 'createChild') {
      saved = await createChild(entered)
    } else if (dialog === 'duplicate') {
      saved = await run(issue => createLinkedIssue({ id: issue.id, revision: issue.revision, kind: 'duplicate', title: entered, includeSubissues }), 'duplicate')
    } else {
      const patch = dialog === 'dueDate' ? { dueDate: entered || null } : { estimate: entered === '' ? null : Number(entered) }
      saved = await run(issue => updateIssueMetadata({ id: issue.id, revision: issue.revision, patch }))
    }
    if (saved) setDialog(null)
  }
  async function copy(kind: 'link' | 'id' | 'title' | 'markdown' | 'branch') {
    try {
      const url = new URL(window.location.href); url.search = workspaceSearch({ issue: task.id })
      const identifier = issueIdentifier(task)
      const named = [identifier, task.title].filter(Boolean).join(' ')
      const slug = task.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60)
      const text = kind === 'link' ? url.href : kind === 'id' ? identifier : kind === 'title' ? named : kind === 'branch' ? (identifier ? `${identifier.toLowerCase()}/${slug}` : slug) : `[${named.replace(/[[\]\\]/g, '\\$&')}](${url.href})`
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
  const dialogs = <>
    {relation && <IssueRelationPicker task={task} kind={relation} validationError={error} open onOpenChange={open => { if (!open) setRelation(null) }} pending={pending} onSelect={targetId => { void run(issue => updateIssueRelation({ id: task.id, revision: issue.revision, kind: relation, targetId })).then(success => { if (success) setRelation(null) }) }} />}
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !pending) setDialog(null) }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{dialog === 'createChild' ? tDialog('createChildTitle') : dialog === 'duplicate' ? tDialog('duplicateTitle') : dialog === 'dueDate' ? tDialog('dueDateTitle') : tDialog('estimateTitle')}</DialogTitle></DialogHeader><form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void submitDialog(fieldRef.current?.value ?? '')}}><FieldGroup><Field><FieldLabel htmlFor="issue-action-value">{dialog === 'dueDate' ? tDialog('dueDateLabel') : dialog === 'estimate' ? tDialog('estimateLabel') : tDialog('taskTitleLabel')}</FieldLabel><Input ref={fieldRef} key={fieldKey} id="issue-action-value" autoFocus type={dialog === 'dueDate' ? 'date' : dialog === 'estimate' ? 'number' : 'text'} min={dialog === 'estimate' ? 0 : undefined} max={dialog === 'estimate' ? 100 : undefined} step={dialog === 'estimate' ? 1 : undefined} defaultValue={fieldDefault} disabled={pending} required={dialog === 'createChild' || dialog === 'duplicate'} maxLength={200} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault() }} /></Field>{dialog === 'duplicate' && <Field orientation="horizontal"><Checkbox id="duplicate-subissues" checked={includeSubissues} onCheckedChange={checked => setIncludeSubissues(!!checked)} /><FieldLabel htmlFor="duplicate-subissues">{tDialog('duplicateSubissues')}</FieldLabel></Field>}</FieldGroup>{error && <FieldError>{error}</FieldError>}<DialogFooter><Button type="button" variant="ghost" disabled={pending} onClick={() => setDialog(null)}>{tCommon('cancel')}</Button><Button type="submit" disabled={pending || (dialog === 'createChild' && !canCreateChild)}>{pending ? tCommon('saving') : dialog === 'createChild' || dialog === 'duplicate' ? tIssue('create.submit') : tCommon('save')}</Button></DialogFooter></form></DialogContent></Dialog>
    <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{tDialog('deleteTitle', { id: issueIdentifier(task, `「${task.title}」`) })}</AlertDialogTitle><AlertDialogDescription>{tDialog('deleteDescription')}</AlertDialogDescription></AlertDialogHeader>{error && <FieldError>{error}</FieldError>}<AlertDialogFooter><AlertDialogCancel disabled={pending}>{tCommon('cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={event => { event.preventDefault(); void run(issue => setIssueDeleted({ id: task.id, revision: issue.revision }), 'delete').then(success => { if (success) setDeleteOpen(false) }) }}>{pending ? tDialog('deleting') : tDialog('deleteAction')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
  return { t, tMenu, tWorkspaceDetail, relationTitle, statusOptions, priorityOptions, copyItems, queuedRelation, setRelation, setError, openDialog, createChild, run, copy, favorite, toggleFavorite, subscribed, unavailable, setDeleteOpen, dialogs }
}

/**
 * The same ⋯ menu as data, for a layer that draws it with its own menu (components/slots/task-detail-contract.ts).
 * Items `assignee`, `project` and `labels` call onProperty; a layer with its own choices puts them in a submenu.
 */
export function useIssueDetailMenu(props: ActionsProps): { items: TaskMenuItem[]; favorite: { on: boolean; label: string; toggle: () => void; disabled: boolean }; subscribed: boolean; toggleSubscribed: () => void; disabled: boolean; dialogs: ReactNode; copyLink: () => void; createChild: (title: string) => Promise<boolean> } {
  const { task, userId, documentTools, onStatus, onPriority, onProperty, onHistory, onMembers, onDocumentTools } = props
  const { tMenu, tWorkspaceDetail, relationTitle, statusOptions, priorityOptions, copyItems, setRelation, setError, openDialog, createChild, run, copy, favorite, toggleFavorite, subscribed, unavailable, setDeleteOpen, dialogs } = useIssueDetailActions(props)
  const relation = (kind: RelationKind) => () => { setError(''); setRelation(kind) }
  const subscribe = () => { void run(() => toggleIssuePreference({ id: task.id, kind: 'subscribe' })) }
  const items: TaskMenuItem[] = [
    { id: 'status', label: tMenu('setStatus'), mark: { kind: 'icon', icon: 'status' }, submenu: statusOptions.map(status => ({ id: status.value, label: status.label, mark: { kind: 'status', value: status.value }, checked: task.status === status.value, onSelect: () => onStatus(status.value) })) },
    { id: 'priority', label: tMenu('setPriority'), mark: { kind: 'icon', icon: 'priority' }, submenu: priorityOptions.map(priority => ({ id: priority.value, label: priority.label, mark: { kind: 'priority', value: priority.value }, checked: task.priority === priority.value, onSelect: () => onPriority(priority.value) })) },
    { id: 'assignee', label: tMenu('assignAssignee'), mark: { kind: 'icon', icon: 'person' }, onSelect: () => onProperty('assignee') },
    { id: 'project', label: tMenu('moveToProject'), mark: { kind: 'icon', icon: 'project' }, onSelect: () => onProperty('project') },
    { id: 'labels', label: tMenu('editLabels'), mark: { kind: 'icon', icon: 'tag' }, onSelect: () => onProperty('labels') },
    { id: 'dueDate', label: task.metadata.dueDate ? tMenu('editDueDate') : tMenu('setDueDate'), mark: { kind: 'icon', icon: 'calendar' }, onSelect: () => openDialog('dueDate') },
    { id: 'estimate', label: tMenu('setEstimate'), mark: { kind: 'icon', icon: 'estimate' }, onSelect: () => openDialog('estimate') },
    ...props.canCreateChild ? [{ id: 'createChild', label: tMenu('createChild'), mark: { kind: 'icon', icon: 'plus' }, divider: true, onSelect: () => openDialog('createChild') } satisfies TaskMenuItem] : [],
    { id: 'addExistingChild', label: tMenu('addExistingChild'), mark: { kind: 'icon', icon: 'listPlus' }, onSelect: relation('child') },
    { id: 'setParent', label: tMenu('setParent'), mark: { kind: 'icon', icon: 'parent' }, onSelect: relation('parent') },
    ...task.metadata.parentId ? [{ id: 'removeParent', label: tMenu('removeParent'), mark: { kind: 'icon', icon: 'remove' }, onSelect: () => { void run(issue => updateIssueRelation({ id: task.id, revision: issue.revision, targetId: null, kind: 'parent', remove: true })) } } satisfies TaskMenuItem] : [],
    { id: 'addRelation', label: tMenu('addRelation'), mark: { kind: 'icon', icon: 'link' }, submenu: (['related', 'blockedBy', 'blocks', 'duplicate'] as RelationKind[]).map(kind => ({ id: kind, label: `${relationTitle(kind)}…`, mark: { kind: 'icon', icon: kind === 'blocks' || kind === 'blockedBy' ? 'flag' : 'link' }, onSelect: relation(kind) })) },
    { id: 'copy', label: tMenu('copy'), mark: { kind: 'icon', icon: 'copy' }, divider: true, submenu: copyItems.map(item => ({ id: item.kind, label: item.label, onSelect: () => { void copy(item.kind) } })) },
    { id: 'openNewTab', label: tMenu('openNewTab'), mark: { kind: 'icon', icon: 'newTab' }, onSelect: () => { const url = new URL(window.location.href); url.search = workspaceSearch({ issue: task.id }); window.open(url.href, '_blank', 'noopener,noreferrer') } },
    { id: 'duplicate', label: tMenu('createDuplicate'), mark: { kind: 'icon', icon: 'copy' }, onSelect: () => openDialog('duplicate') },
    { id: 'favorite', label: favorite ? tMenu('removeFavorite') : tMenu('addFavorite'), mark: { kind: 'icon', icon: 'star' }, onSelect: () => { void toggleFavorite() } },
    { id: 'subscribe', label: subscribed ? tMenu('unsubscribe') : tMenu('subscribe'), mark: { kind: 'icon', icon: subscribed ? 'bellOff' : 'bell' }, onSelect: subscribe },
    { id: 'history', label: tMenu('showHistory'), mark: { kind: 'icon', icon: 'history' }, divider: true, onSelect: onHistory },
    { id: 'pullRequests', label: tMenu('managePullRequests'), mark: { kind: 'icon', icon: 'pullRequest' }, onSelect: () => onProperty('pullRequests') },
    { id: 'members', label: tMenu('manageMembers'), mark: { kind: 'icon', icon: 'members' }, onSelect: onMembers },
    { id: 'documentTools', label: documentTools ? tMenu('backToDescription') : tWorkspaceDetail('advancedTools'), mark: { kind: 'icon', icon: 'document' }, onSelect: onDocumentTools },
    ...task.userId === userId ? [{ id: 'delete', label: tMenu('deleteTask'), mark: { kind: 'icon', icon: 'delete' }, danger: true, divider: true, onSelect: () => { setError(''); setDeleteOpen(true) } } satisfies TaskMenuItem] : [],
  ]
  return { items, favorite: { on: favorite, label: favorite ? tMenu('unfavorite') : tMenu('favorite'), toggle: () => { void toggleFavorite() }, disabled: unavailable }, subscribed, toggleSubscribed: subscribe, disabled: unavailable, dialogs, createChild, copyLink: () => { void copy('link') } }
}
