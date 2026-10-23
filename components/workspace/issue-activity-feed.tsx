'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { Timeline, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from '@/components/reui/timeline'
import { deriveIssueActivity, type ActivityChild, type ActivityVersion } from '@/lib/issue-activity'

export function IssueActivityFeed({ versions, children }: { versions: ActivityVersion[]; children: ActivityChild[] }) {
  const t = useTranslations('Workspace.activity')
  const tDetail = useTranslations('Workspace.detail')
  const tIssue = useTranslations('Issue')
  const format = useFormatter()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const events = deriveIssueActivity(versions, children)
  if (!events.length) return null
  return <Timeline value={events.length}>
    {events.map((event, index) => {
      const label = event.kind === 'created' ? tDetail('createdTask')
        : event.kind === 'status' ? t('changedStatus', { status: statusLabel(event.status ?? '') })
        : event.kind === 'priority' ? t('changedPriority', { priority: priorityLabel(event.priority ?? '') })
        : event.kind === 'title' ? t('changedTitle', { title: event.title ?? '' })
        : event.kind === 'assigned' ? t('assigned', { name: event.assigneeName || t('unknownAssignee') })
        : event.kind === 'unassigned' ? t('unassigned')
        : event.kind === 'labelAdded' ? t('addedLabel', { name: event.title ?? '' })
        : event.kind === 'labelRemoved' ? t('removedLabel', { name: event.title ?? '' })
        : t('addedSubtask', { title: event.title ?? '' })
      return <TimelineItem key={event.id} step={index + 1} className="group-data-[orientation=vertical]/timeline:ms-5 group-data-[orientation=vertical]/timeline:not-last:pb-3">
        <TimelineIndicator className="group-data-[orientation=vertical]/timeline:-left-5 top-[7px] group-data-[orientation=vertical]/timeline:top-[7px] size-1.5 border-0 bg-muted-foreground/40 group-data-completed/timeline-item:bg-muted-foreground/60" />
        <TimelineSeparator className="group-data-[orientation=vertical]/timeline:-left-5 group-data-[orientation=vertical]/timeline:w-px group-data-[orientation=vertical]/timeline:translate-y-[10px] group-data-[orientation=vertical]/timeline:h-full bg-border" />
        <TimelineHeader className="flex flex-wrap items-baseline gap-x-2">
          <TimelineTitle className="font-normal text-foreground/80">{label}</TimelineTitle>
          <TimelineDate className="mb-0 font-normal" dateTime={event.at}>{format.dateTime(new Date(event.at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</TimelineDate>
        </TimelineHeader>
      </TimelineItem>
    })}
  </Timeline>
}
