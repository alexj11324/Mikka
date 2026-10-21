'use client'

import { useId, useState, type ReactNode } from 'react'
import { Calendar, ChartNoAxesColumnIncreasing, ChevronDown, CircleDashed, Signal, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const control = { task, disabled: metadataDisabled, onSaved: onMetadataSaved, onBusyChange: onMetadataBusy, request }
  return <aside id="issue-properties" aria-label="任务属性" className="order-first w-full min-w-0 shrink-0 px-5 pt-3 sm:px-8 lg:sticky lg:top-20 lg:order-last lg:w-60 lg:self-start lg:px-0 lg:pt-0 xl:w-64">
    <Button variant="ghost" className="min-h-11 w-full justify-between lg:hidden" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}><SlidersHorizontal data-icon="inline-start" /><span className="flex-1 text-left">属性与任务关系</span><ChevronDown data-icon="inline-end" className={cn(expanded && 'rotate-180')} /></Button>
    <div id={contentId} className={cn('flex-col gap-6 lg:flex lg:py-0', expanded ? 'flex py-4' : 'hidden')}>
    <section className="flex flex-col items-start gap-1 [&_button]:min-h-11 lg:[&_button]:min-h-0"><h2 className="mb-2 hidden px-2 text-xs font-medium text-muted-foreground lg:block">属性</h2>
      <IssuePropertyMenu label="任务状态" value={status} options={ISSUE_STATUSES} icon={CircleDashed} disabled={pending} onChange={onStatus} />
      <IssuePropertyMenu label="任务优先级" value={priority} options={ISSUE_PRIORITIES} icon={ChartNoAxesColumnIncreasing} disabled={pending} onChange={onPriority} />
      <IssueMetadataControls {...control} section="assignee" />
      {task.metadata.estimate !== null && <Button variant="ghost" size="sm" disabled={metadataDisabled} onClick={onEstimate}><Signal data-icon="inline-start" />{task.metadata.estimate} 点估算</Button>}
      {task.metadata.dueDate && <Button variant="ghost" size="sm" disabled={metadataDisabled} onClick={onDate}><Calendar data-icon="inline-start" /><time dateTime={task.metadata.dueDate}>{task.metadata.dueDate}</time></Button>}
    </section>
    <section className="flex flex-col items-start gap-2"><h3 className="px-2 text-xs font-medium text-muted-foreground">标签</h3><div className="flex flex-wrap gap-2 px-2"><IssueMetadataControls {...control} section="labels" /></div></section>
    <section className="flex flex-col items-start gap-1"><h3 className="mb-1 px-2 text-xs font-medium text-muted-foreground">项目</h3><IssueMetadataControls {...control} section="project" /></section>
    {task.metadata.pullRequests.length > 0 && <section className="flex flex-col items-start gap-2"><h3 className="px-2 text-xs font-medium text-muted-foreground">关联 PR</h3><div className="flex flex-wrap gap-2 px-2"><IssueMetadataControls {...control} section="pullRequests" /></div></section>}
    {task.metadata.pullRequests.length === 0 && request?.target === 'pullRequests' && <IssueMetadataControls {...control} section="pullRequests" />}
    <div className="flex min-w-0 flex-col gap-6 px-2">{relations}</div>
    </div>
  </aside>
}
