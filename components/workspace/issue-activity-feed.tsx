'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { Timeline, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from '@/components/reui/timeline'
import { deriveIssueActivity, groupActivityByMinute, type ActivityChild, type ActivityVersion, type IssueActivityEvent } from '@/lib/issue-activity'

export function IssueActivityFeed({ versions, children }: { versions: ActivityVersion[]; children: ActivityChild[] }) {
  const t = useTranslations('Workspace.activity')
  const tDetail = useTranslations('Workspace.detail')
  const tIssue = useTranslations('Issue')
  const format = useFormatter()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const events = deriveIssueActivity(versions, children)
  if (!events.length) return null
  const labelOf = (event: IssueActivityEvent) => event.kind === 'created' ? tDetail('createdTask')
    : event.kind === 'status' ? t('changedStatus', { status: statusLabel(event.status ?? '') })
    : event.kind === 'priority' ? t('changedPriority', { priority: priorityLabel(event.priority ?? '') })
    : event.kind === 'title' ? t('changedTitle', { title: event.title ?? '' })
    : event.kind === 'assigned' ? t('assigned', { name: event.assigneeName || t('unknownAssignee') })
    : event.kind === 'unassigned' ? t('unassigned')
    : event.kind === 'labelAdded' ? t('addedLabel', { name: event.title ?? '' })
    : event.kind === 'labelRemoved' ? t('removedLabel', { name: event.title ?? '' })
    : t('addedSubtask', { title: event.title ?? '' })
  // R-63: one person's events in the same minute are one row.
  const rows = groupActivityByMinute(events)
  return <Timeline value={rows.length}>
    {rows.map((row, index) => <TimelineItem key={row[0].id} step={index + 1}>
      <TimelineIndicator />
      <TimelineSeparator />
      <TimelineHeader className="flex flex-wrap items-baseline gap-x-2">
        <TimelineTitle>{row.map(labelOf).join(t('separator'))}</TimelineTitle>
        <TimelineDate dateTime={row[0].at}>{format.dateTime(new Date(row[0].at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</TimelineDate>
      </TimelineHeader>
    </TimelineItem>)}
  </Timeline>
}
