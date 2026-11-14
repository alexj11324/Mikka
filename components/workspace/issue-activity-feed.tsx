'use client'

import { Fragment } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { PersonAvatar } from '@/components/person-avatar'
import { AgentSphere } from './issue-assignee-menu'
import type { AgentActivityRow } from './issue-threads'
import { chronologicalActivity, taskHistoryLabel } from '@/lib/task-activity-timeline'
import type { ActivityActorView } from '@/lib/activity-actor-view'
import { activityTimeline, deriveIssueActivity, type ActivityChild, type ActivityVersion, type IssueActivityEvent } from '@/lib/issue-activity'

/**
 * The task's own events in time order, with its Agent rows (R-62): one per Agent stretch, never 「派出线程」
 * (decision 2026-11-04-2200) and never one per run (2026-11-09-0045). A row opens the task's one conversation.
 */
export function IssueActivityFeed({ versions, children, agents = [], issueCode }: { versions: ActivityVersion[]; children: ActivityChild[]; agents?: AgentActivityRow[]; issueCode?: string | null }) {
  const eventsFor = useActivityEvents(versions, children, issueCode)
  const items = eventsFor(agents)
  if (!items.length && !agents.length) return null
  // R-63: one person's events in the same minute are one plain row, led by who did them.
  const events = items.map(item => ({ id: item.id, at: item.at, node: <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <ActorName actor={item.actor} />
    <span className="text-muted-foreground">{item.text}</span>
    <time className="text-xs text-muted-foreground" dateTime={item.at}>{item.time}</time>
  </div> }))
  return <>{chronologicalActivity([...events, ...agents]).map(row => <Fragment key={row.id}>{row.node}</Fragment>)}</>
}

/** One 活动 line as words: who (if known), what they did, and when (R-63: one person's events in the same minute are one line). */
export type ActivityEventItem = { id: string; at: string; actor: ActivityActorView | null; text: string; time: string }

/** The task's own events as words, oldest first, for IssueActivityFeed and a layer that draws the log. */
export function useActivityEvents(versions: ActivityVersion[], children: ActivityChild[], issueCode?: string | null) {
  const t = useTranslations('Workspace.activity')
  const tIssue = useTranslations('Issue')
  const format = useFormatter()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const history = deriveIssueActivity(versions, children, Infinity)
  const labelOf = (event: IssueActivityEvent) => taskHistoryLabel(event, {
    activity: t, created: t('created'), status: statusLabel, priority: priorityLabel, issueCode,
  })
  return (barriers: readonly { id: string; at: string }[]): ActivityEventItem[] => {
    const rows = activityTimeline(history, barriers.map(row => ({ id: row.id, createdAt: row.at })))
    return rows.flatMap(row => row.type === 'thread' ? [] : [{
      id: row.id, at: row.at, actor: row.events[0].actor?.name ? row.events[0].actor : null,
      text: row.events.map(labelOf).join(t('separator')),
      time: format.dateTime(new Date(row.at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    }])
  }
}

/** A person's avatar and name; an agent's mark and name. Rows from before MIK-17 have no actor and show the action alone. */
function ActorName({ actor }: { actor: ActivityActorView | null }) {
  if (!actor?.name) return null
  return <>
    {actor.type === 'agent' ? <AgentSphere name={actor.name} /> : <PersonAvatar name={actor.name} image={actor.avatarUrl} />}
    <span className="font-medium">{actor.name}</span>
  </>
}
