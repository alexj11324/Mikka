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
        : t('addedSubtask', { title: event.title ?? '' })
      return <TimelineItem key={event.id} step={index + 1}>
        <TimelineIndicator />
        <TimelineSeparator />
        <TimelineHeader className="flex flex-wrap items-baseline gap-x-2">
          <TimelineTitle>{label}</TimelineTitle>
          <TimelineDate dateTime={event.at}>{format.dateTime(new Date(event.at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</TimelineDate>
        </TimelineHeader>
      </TimelineItem>
    })}
  </Timeline>
}
