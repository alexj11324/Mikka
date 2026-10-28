'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { moveIssueToProject } from '@/app/actions/projects'
import useSWR from 'swr'
import { Box, Check, Circle, GitPullRequest, Link2, Tag, X } from 'lucide-react'
import { getIssuePropertyOptions, updateIssueMetadata, type IssueMetadataPatch } from '@/app/actions/issue-metadata'
import { LABEL_COLORS, type IssueLabel, type IssueMetadata, type IssuePullRequest } from '@/lib/issue-metadata'
import { useActionError } from '@/lib/use-action-error'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { IssueAssigneeMenu } from './issue-assignee-menu'
import { IssuePropertyMenu } from './issue-property-menu'
import { cn } from '@/lib/utils'
import { ROW_VALUE } from './issue-property-row'
import { PullRequestIcon } from './pull-request-icon'
import { PULL_REQUEST_COLORS, PULL_REQUEST_ICONS } from '@/lib/pull-request-appearance'

export type MetadataSavedIssue = Extract<Awaited<ReturnType<typeof updateIssueMetadata>>, { issue: unknown }>['issue']
type Target = 'project' | 'labels' | 'pullRequests' | 'invite'
export type MetadataRequest = { target: Target | 'assignee'; sequence: number }

export function LabelDot({ color }: { color: IssueLabel['color'] }) {
  return <Circle data-icon="inline-start" className={cn('fill-current', { 'text-label-violet': color === 'violet', 'text-label-blue': color === 'blue', 'text-success-foreground': color === 'green', 'text-warning-foreground': color === 'yellow', 'text-destructive': color === 'red', 'text-muted-foreground': color === 'gray' })} />
}

export function IssueMetadataControls({ task, section = 'all', compact = false, disabled = false, onSaved, onBusyChange, request }: {
  task: { id: string; revision: number; metadata: IssueMetadata }
  section?: 'all' | 'assignee' | 'properties' | 'project' | 'labels' | 'pullRequests'
  request?: MetadataRequest | null
  compact?: boolean; disabled?: boolean
  onSaved: (issue: MetadataSavedIssue) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const tProperty = useTranslations('Metadata.property')
  const tColors = useTranslations('Metadata.colors')
  const tPrState = useTranslations('Metadata.prState')
  const tCommon = useTranslations('Common')
  const actionError = useActionError()
  const colorLabel = (value: IssueLabel['color']) => tColors.has(value as never) ? tColors(value as never) : value
  const prStateLabel = (value: IssuePullRequest['state']) => tPrState.has(value as never) ? tPrState(value as never) : value
  const prStates = (['open', 'draft', 'merged', 'closed'] as const).map(value => ({ value, label: tPrState(value), icon: PULL_REQUEST_ICONS[value] }))
  const titles: Record<Target, string> = { project: tProperty('setProject'), labels: tProperty('editLabels'), pullRequests: tProperty('managePullRequests'), invite: tProperty('invite') }
  const [target, setTarget] = useState<Target | null>(null)
  const [pending, setPending] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [color, setColor] = useState<IssueLabel['color']>('violet')
  const [labels, setLabels] = useState<IssueLabel[]>([])
  const [prs, setPrs] = useState<IssuePullRequest[]>([])
  const [prState, setPrState] = useState<IssuePullRequest['state']>('open')
  const fieldId = useId()
  const { data: options } = useSWR(target === 'project' || target === 'labels' ? ['issue-property-options', task.id] : null, () => getIssuePropertyOptions(task.id))
  const busy = disabled || pending
  useEffect(() => {
    if (!request || request.target === 'assignee') return
    const matches = section === 'all' || section === request.target || (section === 'assignee' && request.target === 'invite')
    if (matches) {
      setError(''); setTarget(request.target); setName(request.target === 'project' ? task.metadata.project ?? '' : '')
      setLabels(task.metadata.labels); setPrs(task.metadata.pullRequests); setPrState('open')
    }
  }, [request, section])

  function open(value: Target) {
    setError(''); setTarget(value); setName(value === 'project' ? task.metadata.project ?? '' : '')
    setLabels(task.metadata.labels); setPrs(task.metadata.pullRequests); setPrState('open')
  }
  async function persist(patch: IssueMetadataPatch, inviteEmail?: string) {
    if (saving.current || disabled) return false
    saving.current = true; setPending(true); setError(''); onBusyChange?.(true)
    try {
      const result = await updateIssueMetadata({ id: task.id, revision: task.revision, patch, inviteEmail })
      if (!('issue' in result) || !result.issue) { setError(actionError(result.error ?? 'issueMetadataSaveFailed')); return false }
      onSaved(result.issue)
      return true
    } catch { setError(tProperty('saveFailedRetry')); return false }
    finally { saving.current = false; setPending(false); onBusyChange?.(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    let patch: IssueMetadataPatch = {}
    if (target === 'project') { await project(name.trim() || null); return }
    if (target === 'labels') {
      const next = name.trim() ? [...labels.filter(label => label.name.toLowerCase() !== name.trim().toLowerCase()), { name: name.trim(), color }] : labels
      patch = { labels: next }
    }
    if (target === 'pullRequests') patch = { pullRequests: name.trim() ? [...prs.filter(pr => pr.url !== name.trim()), { url: name.trim(), state: prState }] : prs }
    if (await persist(patch, target === 'invite' ? name.trim().toLowerCase() : undefined)) setTarget(null)
  }
  async function project(value: string | null) {
    if (saving.current || disabled) return
    const selected = options?.projectRecords.find(item => item.name === value)
    if (value && !selected) { setError(tProperty('selectExistingProject')); return }
    saving.current = true; setPending(true); setError(''); onBusyChange?.(true)
    try {
      const result = await moveIssueToProject({ issueId: task.id, revision: task.revision, projectId: selected?.id ?? null })
      if (!('issue' in result) || !result.issue) { setError(actionError(result.error ?? 'projectMoveFailed')); return }
      onSaved(result.issue); setTarget(null)
    } catch { setError(tProperty('projectLinkFailedRetry')) }
    finally { saving.current = false; setPending(false); onBusyChange?.(false) }
  }
  const metadata = task.metadata
  return <>
    {(section === 'all' || section === 'assignee') && <IssueAssigneeMenu request={request} id={task.id} assignee={metadata.assignee} compact={compact} disabled={busy} onChange={assignee => persist({ assignee })} onInvite={() => open('invite')} />}
    {section !== 'assignee' && <>
      {(section === 'all' || section === 'properties' || section === 'project') && <Button variant={section === 'project' ? 'ghost' : 'outline'} size={section === 'project' ? 'sm' : 'xs'} type="button" className={cn(section === 'project' ? ROW_VALUE : 'h-auto max-w-full justify-start whitespace-normal rounded-full text-left')} disabled={busy} onClick={() => open('project')} title={metadata.project ?? tProperty('setProject')} aria-label={tProperty('projectAria', { name: metadata.project ?? tProperty('unset') })}><Box data-icon="inline-start" className="shrink-0" /><span className={cn(section === 'project' && 'truncate', !metadata.project && 'text-muted-foreground')}>{metadata.project ?? tProperty('addToProject')}</span></Button>}
      {(section === 'all' || section === 'properties' || section === 'labels') && <>
      {metadata.labels.map(label => <Button key={label.name} variant="outline" size="xs" type="button" className="max-w-full rounded-full" disabled={busy} onClick={() => open('labels')} aria-label={tProperty('editLabelAria', { name: label.name })}><LabelDot color={label.color} /><span className="truncate">{label.name}</span></Button>)}
      {!metadata.labels.length && (section === 'labels'
        ? <Button variant="ghost" size="sm" type="button" className={ROW_VALUE} disabled={busy} onClick={() => open('labels')}><Tag data-icon="inline-start" /><span className="text-muted-foreground">{tProperty('addLabels')}</span></Button>
        : <Button variant="outline" size="xs" type="button" className="rounded-full" disabled={busy} onClick={() => open('labels')}><Tag data-icon="inline-start" />{tProperty('labels')}</Button>)}
      </>}
      {(section === 'all' || section === 'properties' || section === 'pullRequests') && <>
      {metadata.pullRequests.map(pr => {
        return <Badge key={pr.url} variant="outline" className={cn('h-6 rounded-md px-2', PULL_REQUEST_COLORS[pr.state])} render={<a href={pr.url} draggable={false} target="_blank" rel="noopener noreferrer" title={tProperty('pullRequestTitle', { state: prStateLabel(pr.state), url: pr.url })} aria-label={tProperty('pullRequestAria', { number: pr.url.split('/').at(-1) ?? '', state: prStateLabel(pr.state) })} />}><PullRequestIcon state={pr.state} />#{pr.url.split('/').at(-1)}</Badge>
      })}
      <Button variant={metadata.pullRequests.length ? 'ghost' : 'outline'} size={metadata.pullRequests.length ? 'icon-xs' : 'xs'} type="button" className="rounded-full" disabled={busy} onClick={() => open('pullRequests')} aria-label={tProperty('managePullRequestsAria')}><Link2 data-icon="inline-start" />{!metadata.pullRequests.length && tProperty('pullRequests')}</Button>
      </>}
    </>}
    {error && !target && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
    <Dialog open={target !== null} onOpenChange={value => { if (!value && !pending) { setTarget(null); setError('') } }}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{target ? titles[target] : tProperty('taskProperties')}</DialogTitle><DialogDescription>{target === 'invite' ? tProperty('inviteDescription') : target === 'pullRequests' ? tProperty('pullRequestsDescription') : target === 'labels' ? tProperty('labelsDescription') : tProperty('defaultDescription')}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {target === 'project' && <Command shouldFilter={false}><CommandInput placeholder={tProperty('projectPlaceholder')} aria-label={tProperty('projectNameAria')} value={name} onValueChange={setName} maxLength={100} /><CommandList><CommandEmpty>{tProperty('noProjectFound')}</CommandEmpty><CommandGroup heading={tProperty('projectGroup')}><CommandItem disabled={busy} onSelect={() => { void project(null) }}><Box /><span className="flex-1">{tProperty('noProject')}</span>{!metadata.project && <Check />}</CommandItem>{(options?.projects ?? []).filter(item => item.toLowerCase().includes(name.toLowerCase())).map(item => <CommandItem key={item} disabled={busy} onSelect={() => { void project(item) }}><Box /><span className="flex-1 truncate">{item}</span>{metadata.project === item && <Check />}</CommandItem>)}</CommandGroup></CommandList></Command>}
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
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="ghost" disabled={pending} onClick={() => setTarget(null)}>{tCommon('cancel')}</Button><Button type="submit" disabled={busy}>{pending ? tCommon('saving') : target === 'invite' ? tProperty('inviteAction') : tCommon('save')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>
}
