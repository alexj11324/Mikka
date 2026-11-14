'use client'

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { pollIssue } from '@/app/actions/issues'
import { moveIssueToProject } from '@/app/actions/projects'
import useSWR from 'swr'
import { Box, Check, Circle, GitPullRequest, Link2, Tag, X } from 'lucide-react'
import { getIssuePropertyOptions, updateIssueMetadata, type IssueMetadataPatch } from '@/app/actions/issue-metadata'
import { LABEL_COLORS, labelKey, pullRequestKey, reconcileMetadataDraft, type IssueLabel, type IssueMetadata, type IssuePullRequest } from '@/lib/issue-metadata'
import { taskProjectOptions } from '@/lib/task-project-options'
import { useActionError } from '@/lib/use-action-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldError } from '@/components/ui/field'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { IssueAssigneeMenu } from './issue-assignee-menu'
import { IssuePropertyMenu } from './issue-property-menu'
import { cn } from '@/lib/utils'
import { ROW_VALUE } from './issue-property-row'
import { IssuePullRequestLink } from './issue-pull-request-link'
import { PULL_REQUEST_ICONS } from '@/lib/pull-request-appearance'

export type MetadataSavedIssue = Extract<Awaited<ReturnType<typeof updateIssueMetadata>>, { issue: unknown }>['issue']
export type OnMetadataChange = (issue: MetadataSavedIssue, source: 'save' | 'refresh') => void
type Target = 'project' | 'labels' | 'pullRequests' | 'invite'
export type MetadataRequest = { target: Target | 'assignee'; sequence: number }

/** small: the 6px dot of a board card's bare label (Figma 看板/标签). */
export function LabelDot({ color, small = false }: { color: IssueLabel['color']; small?: boolean }) {
  return <Circle data-icon="inline-start" className={cn('fill-current', small && 'size-1.5 shrink-0', { 'text-label-violet': color === 'violet', 'text-label-blue': color === 'blue', 'text-success-foreground': color === 'green', 'text-warning-foreground': color === 'yellow', 'text-destructive-foreground': color === 'red', 'text-muted-foreground': color === 'gray' })} />
}

export function IssueMetadataControls({ task, section = 'all', compact = false, disabled = false, onSaved, onBusyChange, request, assigneeAvatar }: {
  task: { id: string; revision: number; metadata: IssueMetadata; projectId?: string | null; workspaceId?: string | null }
  /** Replaces the assignee button's avatar, as the board card's avatar group (R-25). */
  assigneeAvatar?: ReactNode
  /** 'dialog': only the dialog, opened by `request` for any target but the assignee (a layer draws the values). */
  section?: 'all' | 'assignee' | 'properties' | 'project' | 'labels' | 'pullRequests' | 'dialog'
  request?: MetadataRequest | null
  compact?: boolean; disabled?: boolean
  onSaved: OnMetadataChange
  onBusyChange?: (busy: boolean) => void
}) {
  const tProperty = useTranslations('Metadata.property')
  const tColors = useTranslations('Metadata.colors')
  const tPrState = useTranslations('Metadata.prState')
  const tCommon = useTranslations('Common')
  const colorLabel = (value: IssueLabel['color']) => tColors.has(value as never) ? tColors(value as never) : value
  const prStates = (['open', 'draft', 'merged', 'closed'] as const).map(value => ({ value, label: tPrState(value), icon: PULL_REQUEST_ICONS[value] }))
  const titles: Record<Target, string> = { project: tProperty('setProject'), labels: tProperty('editLabels'), pullRequests: tProperty('managePullRequests'), invite: tProperty('invite') }
  const [target, setTarget] = useState<Target | null>(null)
  const { pending, error, setError, persist, project: moveToProject, accessChange, confirmAccess, cancelAccessChange } = useIssueMetadataSave({ task, disabled, onSaved, onBusyChange })
  const [name, setName] = useState('')
  const [color, setColor] = useState<IssueLabel['color']>('violet')
  const [labels, setLabels] = useState<IssueLabel[]>([])
  const [prs, setPrs] = useState<IssuePullRequest[]>([])
  const [prState, setPrState] = useState<IssuePullRequest['state']>('open')
  const editBase = useRef(task)
  const fieldId = useId()
  const { data: options } = useSWR(target === 'project' || target === 'labels' ? ['issue-property-options', task.id] : null, () => getIssuePropertyOptions(task.id))
  const query = name.trim().toLowerCase()
  const busy = disabled || pending
  useEffect(() => {
    if (!request || request.target === 'assignee') return
    const matches = section === 'all' || section === 'dialog' || section === request.target || (section === 'assignee' && request.target === 'invite')
    if (matches) open(request.target)
  }, [request, section])

  function open(value: Target) {
    editBase.current = task
    setError(''); setTarget(value); setName('')
    setLabels(task.metadata.labels); setPrs(task.metadata.pullRequests); setPrState('open')
  }
  function refreshDraft(issue: MetadataSavedIssue) {
    const original = editBase.current.metadata
    if (target === 'labels') {
      const { items, inputChanged } = reconcileMetadataDraft(original.labels, labels, issue.metadata.labels, labelKey, name.trim().toLowerCase())
      setLabels(items)
      if (inputChanged) setName('')
    }
    if (target === 'pullRequests') {
      const { items, inputChanged } = reconcileMetadataDraft(original.pullRequests, prs, issue.metadata.pullRequests, pullRequestKey, name.trim().replace(/\/$/, ''))
      setPrs(items)
      if (inputChanged) setName('')
    }
    editBase.current = issue
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    let patch: IssueMetadataPatch = {}
    if (target === 'project') return
    if (target === 'labels') {
      const next = name.trim() ? [...labels.filter(label => label.name.toLowerCase() !== name.trim().toLowerCase()), { name: name.trim(), color }] : labels
      patch = { labels: next }
    }
    if (target === 'pullRequests') {
      const url = name.trim().replace(/\/$/, '')
      const existing = prs.find(pr => pullRequestKey(pr) === url)
      patch = { pullRequests: url ? [...prs.filter(pr => pullRequestKey(pr) !== url), { ...existing, url, state: prState }] : prs }
    }
    const edit = target === 'labels' || target === 'pullRequests' ? { revision: editBase.current.revision, refreshDraft } : undefined
    if (await persist(patch, target === 'invite' ? name.trim().toLowerCase() : undefined, edit)) setTarget(null)
  }
  async function project(projectId: string | null) {
    if (projectId === task.projectId || await moveToProject(projectId)) setTarget(null)
  }
  const metadata = task.metadata
  return <>
    {(section === 'all' || section === 'assignee') && <IssueAssigneeMenu request={request} id={task.id} assignee={metadata.assignee} avatar={assigneeAvatar} compact={compact} disabled={busy} onChange={assignee => persist({ assignee })} onInvite={() => open('invite')} />}
    {section !== 'assignee' && section !== 'dialog' && <>
      {(section === 'all' || section === 'properties' || section === 'project') && <Button variant={section === 'project' ? 'ghost' : 'outline'} size={section === 'project' ? 'sm' : 'xs'} type="button" className={cn(section === 'project' ? ROW_VALUE : 'h-auto max-w-full justify-start whitespace-normal rounded-full text-left')} disabled={busy} onClick={() => open('project')} title={metadata.project ?? tProperty('setProject')} aria-label={tProperty('projectAria', { name: metadata.project ?? tProperty('unset') })}><Box data-icon="inline-start" className="shrink-0" /><span className={cn(section === 'project' && 'truncate', !metadata.project && 'text-muted-foreground')}>{metadata.project ?? tProperty('addToProject')}</span></Button>}
      {(section === 'all' || section === 'properties' || section === 'labels') && <>
      {metadata.labels.map(label => <Button key={label.name} variant="outline" size="xs" type="button" className="max-w-full rounded-full" disabled={busy} onClick={() => open('labels')} aria-label={tProperty('editLabelAria', { name: label.name })}><LabelDot color={label.color} /><span className="truncate">{label.name}</span></Button>)}
      {!metadata.labels.length && (section === 'labels'
        ? <Button variant="ghost" size="sm" type="button" className={ROW_VALUE} disabled={busy} onClick={() => open('labels')}><Tag data-icon="inline-start" /><span className="text-muted-foreground">{tProperty('addLabels')}</span></Button>
        : <Button variant="outline" size="xs" type="button" className="rounded-full" disabled={busy} onClick={() => open('labels')}><Tag data-icon="inline-start" />{tProperty('labels')}</Button>)}
      </>}
      {(section === 'all' || section === 'properties' || section === 'pullRequests') && <>
      {metadata.pullRequests.map(pr => <IssuePullRequestLink key={pr.url} issueId={task.id} pr={pr} compact={compact} />)}
      <Button variant={metadata.pullRequests.length ? 'ghost' : 'outline'} size={metadata.pullRequests.length ? 'icon-xs' : 'xs'} type="button" className="rounded-full" disabled={busy} onClick={() => open('pullRequests')} aria-label={tProperty('managePullRequestsAria')}><Link2 data-icon="inline-start" />{!metadata.pullRequests.length && tProperty('pullRequests')}</Button>
      </>}
    </>}
    {error && !target && section !== 'dialog' && <FieldError className="w-full text-xs">{error}</FieldError>}
    <Dialog open={target !== null} onOpenChange={value => { if (!value && !pending) { setTarget(null); setError('') } }}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{target ? titles[target] : tProperty('taskProperties')}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {target === 'project' && <Command shouldFilter={false}>
            <CommandInput placeholder={tProperty('projectPlaceholder')} aria-label={tProperty('projectNameAria')} value={name} onValueChange={setName} maxLength={100} />
            <CommandList>
              <CommandEmpty>{tProperty('noProjectFound')}</CommandEmpty>
              <CommandGroup heading={tProperty('projectGroup')}>
                {!query && <CommandItem value="none" disabled={busy} onSelect={() => { void project(null) }}>
                  <Box /><span className="flex-1">{tProperty('noProject')}</span>{!task.projectId && !metadata.project && <Check />}
                </CommandItem>}
                {taskProjectOptions(options?.projectRecords ?? [], task.projectId)
                  .filter(item => item.label.toLowerCase().includes(query) || item.id.includes(query))
                  .map(item => <CommandItem key={item.id} value={item.id} disabled={busy} onSelect={() => { void project(item.id) }}>
                    <Box /><span className="min-w-0 flex-1"><span className="block truncate">{item.label}</span>
                      {item.description && <span className="block text-xs text-muted-foreground">{item.description}</span>}
                    </span>{item.checked && <Check />}
                  </CommandItem>)}
              </CommandGroup>
            </CommandList>
          </Command>}
          {target === 'labels' && <>
            <FieldSet>
              <FieldLegend variant="label">{tProperty('existingLabels')}</FieldLegend>
              {[...new Map([...(options?.labels ?? []), ...labels].map(label => [label.name, label])).values()].length === 0
                ? <Empty className="border border-dashed"><EmptyHeader><EmptyTitle>{tProperty('existingLabels')}</EmptyTitle><EmptyDescription>{tProperty('noLabelsYet')}</EmptyDescription></EmptyHeader></Empty>
                : <FieldGroup className="gap-3">{[...new Map([...(options?.labels ?? []), ...labels].map(label => [label.name, label])).values()].map(label => <Field key={label.name} orientation="horizontal"><Checkbox id={`${fieldId}-${label.name}`} disabled={busy} checked={labels.some(item => item.name === label.name)} onCheckedChange={checked => setLabels(current => checked ? [...current.filter(item => item.name !== label.name), label] : current.filter(item => item.name !== label.name))} /><FieldLabel htmlFor={`${fieldId}-${label.name}`}><LabelDot color={label.color} />{label.name}</FieldLabel></Field>)}</FieldGroup>}
            </FieldSet>
            <FieldSet>
              <FieldLegend variant="label">{tProperty('createLabel')}</FieldLegend>
              <FieldGroup><Field><FieldLabel htmlFor={fieldId}>{tProperty('newLabelName')}</FieldLabel><Input id={fieldId} value={name} onChange={event => setName(event.target.value)} placeholder={tProperty('labelNamePlaceholder')} maxLength={40} disabled={busy} /></Field><Field><FieldLabel>{tProperty('labelColor')}</FieldLabel><IssuePropertyMenu label={tProperty('labelColor')} value={color} options={LABEL_COLORS.map(value => ({ value, label: colorLabel(value) }))} icon={Tag} disabled={busy} onChange={value => setColor(value as IssueLabel['color'])} /></Field></FieldGroup>
            </FieldSet>
          </>}
          {target === 'pullRequests' && <>
            <div className="flex flex-col gap-3">{prs.map(pr => <div key={pr.url} className="flex min-w-0 items-center gap-2"><a href={pr.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-sm underline">{pr.url.replace('https://github.com/', '')}</a><IssuePropertyMenu label={tProperty('prStateLabel', { number: pr.url.split('/').at(-1) ?? '' })} value={pr.state} options={prStates} icon={GitPullRequest} compact disabled={busy} onChange={value => setPrs(current => current.map(item => item.url === pr.url ? { ...item, state: value as IssuePullRequest['state'] } : item))} /><Button variant="ghost" size="icon-xs" disabled={busy} aria-label={tProperty('removePrAria', { number: pr.url.split('/').at(-1) ?? '' })} onClick={() => setPrs(current => current.filter(item => item.url !== pr.url))}><X data-icon="inline-start" /></Button></div>)}</div>
            <FieldGroup><Field><FieldLabel htmlFor={fieldId}>{tProperty('newPrLink')}</FieldLabel><Input id={fieldId} type="url" value={name} onChange={event => setName(event.target.value)} placeholder="https://github.com/owner/repo/pull/81" maxLength={500} disabled={busy} /></Field><Field><FieldLabel>{tProperty('newPrState')}</FieldLabel><IssuePropertyMenu label={tProperty('newPrState')} value={prState} options={prStates} icon={GitPullRequest} disabled={busy} onChange={value => setPrState(value as IssuePullRequest['state'])} /></Field></FieldGroup>
          </>}
          {target === 'invite' && <FieldGroup><Field><FieldLabel htmlFor={fieldId}>{tProperty('memberEmail')}</FieldLabel><Input id={fieldId} type="email" value={name} onChange={event => setName(event.target.value)} placeholder={tProperty('memberEmailPlaceholder')} required maxLength={254} disabled={busy} /></Field></FieldGroup>}
          {error && <FieldError>{error}</FieldError>}
          <DialogFooter><Button type="button" variant="ghost" disabled={pending} onClick={() => setTarget(null)}>{tCommon('cancel')}</Button>{target !== 'project' && <Button type="submit" disabled={busy}>{pending ? tCommon('saving') : target === 'invite' ? tProperty('inviteAction') : tCommon('save')}</Button>}</DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <AccessChangeDialog change={accessChange} pending={pending} onConfirm={confirmAccess} onCancel={cancelAccessChange} />
  </>
}

/**
 * The confirmAccess handshake's last step (ALE-26): a project move that would
 * change who can read the task writes nothing until this is accepted, and then
 * replays the same move.
 */
export function AccessChangeDialog({ change, pending, onConfirm, onCancel }: { change: { tasks: number } | null; pending: boolean; onConfirm: () => Promise<boolean>; onCancel: () => void }) {
  const tProperty = useTranslations('Metadata.property')
  const tCommon = useTranslations('Common')
  return <AlertDialog open={Boolean(change)} onOpenChange={open => { if (!open && !pending) onCancel() }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{tProperty('accessChangeTitle')}</AlertDialogTitle>
        <AlertDialogDescription>{tProperty('accessChangeBody', { tasks: change?.tasks ?? 0 })}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>{tCommon('cancel')}</AlertDialogCancel>
        <AlertDialogAction disabled={pending} onClick={() => { void onConfirm() }}>{pending ? tCommon('saving') : tProperty('accessChangeConfirm')}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}

/** The metadata saves behind IssueMetadataControls, for it and for a layer that draws the values itself. */
export function useIssueMetadataSave({ task, disabled = false, onSaved, onBusyChange }: { task: { id: string; revision: number; workspaceId?: string | null }; disabled?: boolean; onSaved: OnMetadataChange; onBusyChange?: (busy: boolean) => void }) {
  const tProperty = useTranslations('Metadata.property')
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState('')
  async function persist(patch: IssueMetadataPatch, inviteEmail?: string, edit?: { revision: number; refreshDraft: (issue: MetadataSavedIssue) => void }) {
    if (saving.current || disabled) return false
    saving.current = true; setPending(true); setError(''); onBusyChange?.(true)
    try {
      const revision = edit?.revision ?? task.revision
      const result = await updateIssueMetadata({ id: task.id, revision, patch, inviteEmail })
      if (result.error === 'issueOutdated') {
        const latest = await pollIssue(task.id)
        if (latest.error) { setError(actionError(latest.error)); return false }
        if (latest.issue?.id === task.id && latest.issue.revision > revision) {
          onSaved(latest.issue, 'refresh')
          if (latest.issue.canSteer === false) { setError(actionError('issueAccessChanged')); return false }
          edit?.refreshDraft(latest.issue)
          setError(actionError('issueStale'))
          return false
        }
      }
      if (!('issue' in result) || !result.issue) { setError(actionError(result.error ?? 'issueMetadataSaveFailed')); return false }
      onSaved(result.issue, 'save')
      return true
    } catch { setError(tProperty('saveFailedRetry')); return false }
    finally { saving.current = false; setPending(false); onBusyChange?.(false) }
  }
  /** A project move the server refused until the person confirms who it removes. */
  const [accessChange, setAccessChange] = useState<{ projectId: string | null; tasks: number } | null>(null)
  async function project(projectId: string | null, confirmAccess = false) {
    if (saving.current || disabled) return false
    saving.current = true; setPending(true); setError(''); onBusyChange?.(true)
    try {
      const result = await moveIssueToProject({ issueId: task.id, revision: task.revision, projectId, ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}), ...(confirmAccess ? { confirmAccess } : {}) })
      // The move changes who can read the task: nothing was written, and the same
      // move replays once the person confirms.
      if (result.error && 'confirmable' in result && result.confirmable) {
        setAccessChange({ projectId, tasks: Number(result.params?.tasks ?? 1) })
        return false
      }
      if (!('issue' in result) || !result.issue) { setError(actionError(result.error ?? 'projectMoveFailed')); return false }
      onSaved(result.issue, 'save'); return true
    } catch { setError(tProperty('projectLinkFailedRetry')); return false }
    finally { saving.current = false; setPending(false); onBusyChange?.(false) }
  }
  return { pending, error, setError, persist, project, accessChange,
    /** Replays the refused move with the confirmation the server asked for. */
    confirmAccess: async () => { const pendingMove = accessChange; setAccessChange(null); if (!pendingMove) return false; return project(pendingMove.projectId, true) },
    cancelAccessChange: () => setAccessChange(null) }
}
