'use client'

import { Fragment } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { PersonAvatar } from '@/components/person-avatar'
import { AgentSphere } from './issue-assignee-menu'
import type { AgentActivityRow } from './issue-threads'
import type { ActivityActorView } from '@/lib/activity-actor-view'
import { activityTimeline, deriveIssueActivity, type ActivityChild, type ActivityVersion, type IssueActivityEvent } from '@/lib/issue-activity'

/**
 * The task's own events in time order, with its Agent rows (R-62): one per Agent stretch, never 「派出线程」
 * (decision 2026-11-04-2200) and never one per run (2026-11-09-0045). A row opens the task's one conversation.
 */
export function IssueActivityFeed({ versions, children, agents = [] }: { versions: ActivityVersion[]; children: ActivityChild[]; agents?: AgentActivityRow[] }) {
  const t = useTranslations('Workspace.activity')
  const tDetail = useTranslations('Workspace.detail')
  const tIssue = useTranslations('Issue')
  const format = useFormatter()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const rows = activityTimeline(deriveIssueActivity(versions, children), [])
  if (!rows.length && !agents.length) return null
  const labelOf = (event: IssueActivityEvent) => event.kind === 'created' ? tDetail('createdTask')
    : event.kind === 'status' ? t('changedStatus', { status: statusLabel(event.status ?? '') })
    : event.kind === 'priority' ? t('changedPriority', { priority: priorityLabel(event.priority ?? '') })
    : event.kind === 'title' ? t('changedTitle', { title: event.title ?? '' })
    : event.kind === 'assigned' ? t(event.assignmentTarget === 'delegate' ? 'delegated' : 'assigned', { name: event.assigneeName || t('unknownAssignee') })
    : event.kind === 'unassigned' ? t(event.assignmentTarget === 'delegate' ? 'undelegated' : 'unassigned')
    : event.kind === 'labelAdded' ? t('addedLabel', { name: event.title ?? '' })
    : event.kind === 'labelRemoved' ? t('removedLabel', { name: event.title ?? '' })
    : t('addedSubtask', { title: event.title ?? '' })
  // R-63: one person's events in the same minute are one plain row, led by who did them.
  const events = rows.flatMap(row => row.type === 'thread' ? [] : [{ id: row.id, at: row.at, node: <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <ActorName actor={row.events[0].actor ?? null} />
    <span className="text-muted-foreground">{row.events.map(labelOf).join(t('separator'))}</span>
    <time className="text-xs text-muted-foreground" dateTime={row.at}>{format.dateTime(new Date(row.at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
  </div> }])
  return <>{[...events, ...agents].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()).map(row => <Fragment key={row.id}>{row.node}</Fragment>)}</>
}

/** A person's avatar and name; an agent's mark and name. Rows from before MIK-17 have no actor and show the action alone. */
function ActorName({ actor }: { actor: ActivityActorView | null }) {
  if (!actor?.name) return null
  return <>
    {actor.type === 'agent' ? <AgentSphere name={actor.name} /> : <PersonAvatar name={actor.name} image={actor.avatarUrl} />}
    <span className="font-medium">{actor.name}</span>
  </>
}
