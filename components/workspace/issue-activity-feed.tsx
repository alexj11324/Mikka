'use client'

import { Fragment } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { cn } from 'cn'
import { PersonAvatar } from '@/components/person-avatar'
import { Button } from '@/components/ui/button'
import { AgentSphere } from './issue-assignee-menu'
import type { AgentActivityRow } from './issue-threads'
import { activityLineParts, chronologicalActivity, type ActivityPiece, type ActivityStretch, type ActivitySubject } from '@/lib/task-activity-timeline'
import type { ActivityActorView } from '@/lib/activity-actor-view'
import { activityTimeline, deriveIssueActivity, type ActivityChild, type ActivityVersion } from '@/lib/issue-activity'
import { openTask, openThread } from '@/components/workspace/workspace-navigation'

/**
 * The task's own events in time order, with its Agent rows (R-62): one per Agent stretch, never 「派出线程」
 * (decision 2026-11-04-2200) and never one per run (2026-11-09-0045). A row opens the task's one conversation.
 */
export function IssueActivityFeed({ versions, children, agents = [], task, stretches }: {
  versions: ActivityVersion[]
  children: ActivityChild[]
  agents?: AgentActivityRow[]
  /** The page's task, so a code in the sentence opens it. Absent on a caller that only needs the words. */
  task?: ActivitySubject
  stretches?: readonly ActivityStretch[]
}) {
  const eventsFor = useActivityEvents(versions, children, { task, stretches })
  const items = eventsFor(agents)
  if (!items.length && !agents.length) return null
  // R-63: one person's events in the same minute are one plain row, led by who did them.
  const events = items.map(item => ({ id: item.id, at: item.at, node: <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <ActorMark actor={item.actor} />
    <ActivitySentence parts={item.parts} />
    <time className="text-xs text-muted-foreground" dateTime={item.at}>{item.time}</time>
  </div> }))
  return <>{chronologicalActivity([...events, ...agents]).map(row => <Fragment key={row.id}>{row.node}</Fragment>)}</>
}

/** One 活动 line: who (if known) once, then the clauses, and when (R-63: one person's events in the same minute are one line). */
export type ActivityEventItem = {
  id: string
  at: string
  actor: ActivityActorView | null
  /** The clauses only, so a renderer that still paints `who` beside `text` does not repeat the name. */
  text: string
  /** The name once, then the clauses. A code is a task part; an Agent name is a thread part when a run matches. */
  parts: ActivityPiece[]
  time: string
}

/** The task's own events as words, oldest first, for IssueActivityFeed and a layer that draws the log. */
export function useActivityEvents(versions: ActivityVersion[], children: ActivityChild[], context?: { task?: ActivitySubject | null; stretches?: readonly ActivityStretch[] }) {
  const t = useTranslations('Workspace.activity')
  const tDetail = useTranslations('Workspace.detail')
  const tWork = useTranslations('IssueDetail.work')
  const tIssue = useTranslations('Issue')
  const format = useFormatter()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const history = deriveIssueActivity(versions, children, Infinity)
  const labels = { activity: t, created: tDetail('createdTask'), status: statusLabel, priority: priorityLabel }
  return (barriers: readonly { id: string; at: string }[]): ActivityEventItem[] => {
    const rows = activityTimeline(history, barriers.map(row => ({ id: row.id, createdAt: row.at })))
    return rows.flatMap(row => {
      if (row.type === 'thread') return []
      const actor = row.events[0].actor ?? null
      const parts = activityLineParts(row.events, labels, context?.task, t('separator'), actor, context?.stretches ?? [])
      const clause = actor?.name ? parts.slice(2) : parts
      const fallback = !actor?.name && (actor?.type === 'system' || actor?.type === 'agent') ? tWork(actor.type) : null
      return [{
        id: row.id, at: row.at, actor, parts: fallback ? [{ kind: 'text', text: fallback, name: true }, { kind: 'text', text: ' ' }, ...parts] : parts,
        text: clause.map(part => part.text).join(''),
        time: format.dateTime(new Date(row.at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      }]
    })
  }
}

/** A person's avatar, or an agent's mark. The name is a part of the sentence. Rows from before MIK-17 have no actor. */
function ActorMark({ actor }: { actor: ActivityActorView | null }) {
  if (!actor?.name) return null
  return actor.type === 'agent' ? <AgentSphere name={actor.name} /> : <PersonAvatar name={actor.name} image={actor.avatarUrl} />
}

function ActivitySentence({ parts }: { parts: ActivityPiece[] }) {
  const t = useTranslations('IssueDetail.frame')
  const chip = 'h-auto p-0 font-medium text-foreground hover:underline'
  return <span className="min-w-0">{parts.map((part, index) => {
    if (part.kind === 'thread') return <Button key={`${part.runId}:${index}`} type="button" variant="bare" size="bare" className={chip} aria-label={t('openThread', { name: part.text })} onClick={() => openThread(part.runId)}>{part.text}</Button>
    if (part.kind === 'task') return <Button key={`${part.taskId}:${index}`} type="button" variant="bare" size="bare" className={chip} onClick={() => openTask(part.taskId)}>{part.text}</Button>
    if (part.kind === 'pull') return <a key={`${part.href}:${index}`} className="font-medium text-foreground underline-offset-2 hover:underline" href={part.href} target="_blank" rel="noreferrer">{part.text}</a>
    return <span key={index} className={cn(part.name && 'font-medium text-foreground', !part.name && 'text-muted-foreground')}>{part.text}</span>
  })}</span>
}
