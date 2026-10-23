'use client'

import { useId, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Calendar, ChartNoAxesColumnIncreasing, ChevronDown, CircleDashed, Signal, SlidersHorizontal } from 'lucide-react'
import { IssueTeamControl } from '@/components/teams/issue-team-control'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldGroup, FieldLabel } from '@/components/ui/field'
import { IssuePropertyMenu } from './issue-property-menu'
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from './issue-properties'
import { IssueMetadataControls, type MetadataRequest, type MetadataSavedIssue } from './issue-metadata-controls'
import type { IssueMetadata } from '@/lib/issue-metadata'
import { cn } from '@/lib/utils'

export function IssueDetailProperties({ task, onMetadataSaved, metadataDisabled, onMetadataBusy, status, priority, pending, onStatus, onPriority, request, relations, onDate, onEstimate }: {
  task: { id: string; revision: number; metadata: IssueMetadata }; onMetadataSaved: (issue: MetadataSavedIssue) => void; metadataDisabled: boolean; onMetadataBusy: (busy: boolean) => void
  status: string; priority: string; pending: boolean; onStatus: (value: string) => void; onPriority: (value: string) => void
  request: MetadataRequest | null; relations: ReactNode; onDate: () => void; onEstimate: () => void
}) {
  const t = useTranslations('Issue')
  const tDetail = useTranslations('IssueDetail')
  const tMetadata = useTranslations('Metadata.property')
  const statusLabel = (value: string) => t.has(`status.${value}` as never) ? t(`status.${value}` as never) : value
  const priorityLabel = (value: string) => t.has(`priority.${value}` as never) ? t(`priority.${value}` as never) : value
  const statusOptions = ISSUE_STATUSES.map(item => ({ ...item, label: statusLabel(item.value) }))
  const priorityOptions = ISSUE_PRIORITIES.map(item => ({ ...item, label: priorityLabel(item.value) }))
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const control = { task, disabled: metadataDisabled, onSaved: onMetadataSaved, onBusyChange: onMetadataBusy, request }
  return <aside id="issue-properties" aria-label={t('properties')} className="order-1 w-full min-w-0 lg:sticky lg:top-20 lg:order-2 lg:self-start">
    <Button variant="ghost" className="min-h-11 w-full justify-between lg:hidden" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}><SlidersHorizontal data-icon="inline-start" /><span className="flex-1 text-left">{tDetail('propertiesRelations')}</span><ChevronDown data-icon="inline-end" className={cn(expanded && 'rotate-180')} /></Button>
    <div id={contentId} className={cn('flex-col gap-6 lg:flex lg:py-0', expanded ? 'flex py-4' : 'hidden')}>
    <section className="flex flex-col gap-3 [&_button]:min-h-11 lg:[&_button]:min-h-0"><h2 className="hidden text-xs font-medium text-muted-foreground lg:block">{tDetail('propertiesHeading')}</h2>
      <FieldGroup className="gap-3">
        <Field orientation="horizontal" className="items-center gap-3"><FieldLabel className="w-20 shrink-0">{t('statusLabel')}</FieldLabel><FieldContent className="min-w-0"><IssuePropertyMenu label={t('statusLabel')} value={status} options={statusOptions} icon={CircleDashed} disabled={pending} onChange={onStatus} /></FieldContent></Field>
        <Field orientation="horizontal" className="items-center gap-3"><FieldLabel className="w-20 shrink-0">{t('priorityLabel')}</FieldLabel><FieldContent className="min-w-0"><IssuePropertyMenu label={t('priorityLabel')} value={priority} options={priorityOptions} icon={ChartNoAxesColumnIncreasing} disabled={pending} onChange={onPriority} /></FieldContent></Field>
        <Field orientation="horizontal" className="items-center gap-3"><FieldLabel className="w-20 shrink-0">{tMetadata('assignee')}</FieldLabel><FieldContent className="min-w-0"><IssueMetadataControls {...control} section="assignee" /></FieldContent></Field>
        <Field orientation="horizontal" className="items-start gap-3"><FieldLabel className="w-20 shrink-0">{tMetadata('labels')}</FieldLabel><FieldContent className="min-w-0"><div className="flex flex-wrap gap-2"><IssueMetadataControls {...control} section="labels" /></div></FieldContent></Field>
        <Field orientation="horizontal" className="items-center gap-3"><FieldLabel className="w-20 shrink-0">{tMetadata('project')}</FieldLabel><FieldContent className="min-w-0"><IssueMetadataControls {...control} section="project" /></FieldContent></Field>
      </FieldGroup>
      {task.metadata.estimate !== null && <Button variant="ghost" size="sm" disabled={metadataDisabled} onClick={onEstimate}><Signal data-icon="inline-start" />{tMetadata('estimatePoints', { count: task.metadata.estimate })}</Button>}
      {task.metadata.dueDate && <Button variant="ghost" size="sm" disabled={metadataDisabled} onClick={onDate}><Calendar data-icon="inline-start" /><time dateTime={task.metadata.dueDate}>{task.metadata.dueDate}</time></Button>}
    </section>
    {task.metadata.pullRequests.length > 0 && <section className="flex flex-col items-start gap-2"><h3 className="px-2 text-xs font-medium text-muted-foreground">{tMetadata('pullRequests')}</h3><div className="flex flex-wrap gap-2 px-2"><IssueMetadataControls {...control} section="pullRequests" /></div></section>}
    {task.metadata.pullRequests.length === 0 && request?.target === 'pullRequests' && <IssueMetadataControls {...control} section="pullRequests" />}
    <IssueTeamControl issueId={task.id} disabled={metadataDisabled} />
    <div className="flex min-w-0 flex-col gap-6 px-2">{relations}</div>
    </div>
  </aside>
}
