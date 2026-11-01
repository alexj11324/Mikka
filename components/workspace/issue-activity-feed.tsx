'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { PersonAvatar } from '@/components/person-avatar'
import { AgentSphere } from './issue-assignee-menu'
import type { ActivityActorView } from '@/lib/activity-actor-view'
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
  // R-63: one person's events in the same minute are one plain row, led by who did them.
  const rows = groupActivityByMinute(events)
  return <>{rows.map(row => <div key={row[0].id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <ActorName actor={row[0].actor ?? null} />
    <span className="text-muted-foreground">{row.map(labelOf).join(t('separator'))}</span>
    <time className="text-xs text-muted-foreground" dateTime={row[0].at}>{format.dateTime(new Date(row[0].at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
  </div>)}</>
}

/** A person's avatar and name; an agent's mark and name. Rows from before MIK-17 have no actor and show the action alone. */
function ActorName({ actor }: { actor: ActivityActorView | null }) {
  if (!actor?.name) return null
  return <>
    {actor.type === 'agent' ? <AgentSphere name={actor.name} /> : <PersonAvatar name={actor.name} image={actor.avatarUrl} />}
    <span className="font-medium">{actor.name}</span>
  </>
}
