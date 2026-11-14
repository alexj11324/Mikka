import type { ActivityActorView } from './activity-actor-view'
import type { ThreadRecord } from './task-discussion'

export type IssueActivityEvent = {
  id: string
  at: string
  kind: 'created' | 'status' | 'priority' | 'title' | 'assigned' | 'unassigned' | 'subtask' | 'labelAdded' | 'labelRemoved'
  status?: string
  priority?: string
  title?: string
  assigneeName?: string
  /** Absent means the human assignee. Keep the existing event kinds for old
   * consumers, but never describe clearing a Delegate as clearing the person. */
  assignmentTarget?: 'delegate'
  /** `type:id` of whoever made the change; null for rows from before MIK-17 and for subtasks. */
  source?: { kind: 'revision'; id: string; revision: number } | { kind: 'subtask'; id: string }
  actorKey?: string | null
  /** Who made the change, as the server resolved it (R-63 names them in front of the row). */
  actor?: ActivityActorView | null
}

/** Time of the source event, then stable identity. Equal clocks cannot reorder
 * when another entry point fetched the same sources in a different sequence. */
export function chronologicalActivity<T extends { id: string; at: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
}

export type TaskDiscussionEvent = {
  kind: 'comment' | 'reply'
  id: string
  threadId: string
  messageId: string
  author: string
  authorId: string | null
  body: string
  at: string
  resolved: boolean
}

export type PullRequestActivitySource = { url: string; title: string | null; createdAt: string | null; mergedAt: string | null; state: 'open' | 'closed' | 'merged' }
export type PullRequestTimelineEvent = { kind: 'event'; id: string; at: string; who: null; mark: { kind: 'icon'; icon: 'pullRequest' }; text: string; time: string }

/** Build only events whose exact provider timestamps are available; updatedAt is deliberately not a fallback. */
export function pullRequestActivityEvents(items: readonly PullRequestActivitySource[], labels: {
  opened: (repo: string, number: string, title: string) => string
  merged: (repo: string, number: string, title: string) => string
  time: (at: string) => string
}): PullRequestTimelineEvent[] {
  const rows: PullRequestTimelineEvent[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(item.url)
    if (!match || seen.has(item.url) || !item.title?.trim()) continue
    seen.add(item.url)
    const [, repo, number] = match
    const validTime = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? value : null
    const createdAt = validTime(item.createdAt)
    if (createdAt) rows.push({ kind: 'event', id: `pull:${item.url}:opened`, at: createdAt, who: null, mark: { kind: 'icon', icon: 'pullRequest' }, text: labels.opened(repo, number, item.title), time: labels.time(createdAt) })
    const mergedAt = item.state === 'merged' ? validTime(item.mergedAt) : null
    if (mergedAt) rows.push({ kind: 'event', id: `pull:${item.url}:merged`, at: mergedAt, who: null, mark: { kind: 'icon', icon: 'pullRequest' }, text: labels.merged(repo, number, item.title), time: labels.time(mergedAt) })
  }
  return rows
}

export type TaskActivityFact =
  | { kind: 'history'; id: string; at: string; event: IssueActivityEvent }
  | TaskDiscussionEvent

/** Read each discussion from its Yjs identity. Reply/resolve still address
 * that thread; transcript and Factory commands never receive these ids. */
export function taskDiscussionEvents(threads: readonly ThreadRecord[]): TaskDiscussionEvent[] {
  return threads.flatMap(thread => thread.messages.map((message, i) => ({
    kind: i === 0 ? 'comment' as const : 'reply' as const,
    id: `discussion:${thread.id}:${message.id}`, threadId: thread.id, messageId: message.id,
    author: message.author, authorId: message.authorUserId ?? null,
    body: message.body, at: message.at, resolved: thread.resolved,
  })))
}

export function taskActivityFacts(history: readonly IssueActivityEvent[], threads: readonly ThreadRecord[]): TaskActivityFact[] {
  return chronologicalActivity<TaskActivityFact>([
    ...history.map(event => ({ kind: 'history' as const, id: `history:${event.id}`, at: event.at, event })),
    ...taskDiscussionEvents(threads),
  ])
}

type HistoryLabels = Pick<typeof import('../messages/en.json')['Workspace']['activity'],
  'unknownAssignee' | 'changedStatus' | 'changedStatusWithIssue' | 'createdIssue' | 'changedPriority' | 'changedTitle' | 'assigned' | 'unassigned' | 'unassignedNamed' | 'addedLabel' | 'removedLabel' | 'addedSubtask'>

/** Both renderers supply their locale; the source event determines the wording. */
export function taskHistoryLabel(event: IssueActivityEvent, labels: {
  created: string
  activity: (key: keyof HistoryLabels, values?: Record<string, string>) => string
  status: (value: string) => string
  priority: (value: string) => string
  issueCode?: string | null
}) {
  const t = labels.activity
  switch (event.kind) {
    case 'created': return labels.issueCode ? t('createdIssue', { issue: labels.issueCode }) : labels.created
    case 'status': return labels.issueCode
      ? t('changedStatusWithIssue', { issue: labels.issueCode, status: labels.status(event.status ?? '') })
      : t('changedStatus', { status: labels.status(event.status ?? '') })
    case 'priority': return t('changedPriority', { priority: labels.priority(event.priority ?? '') })
    case 'title': return t('changedTitle', { title: event.title ?? '' })
    case 'assigned': return t('assigned', { name: event.assigneeName || t('unknownAssignee') })
    case 'unassigned': return event.assigneeName ? t('unassignedNamed', { name: event.assigneeName }) : t('unassigned')
    case 'labelAdded': return t('addedLabel', { name: event.title ?? '' })
    case 'labelRemoved': return t('removedLabel', { name: event.title ?? '' })
    case 'subtask': return t('addedSubtask', { title: event.title ?? '' })
  }
}
