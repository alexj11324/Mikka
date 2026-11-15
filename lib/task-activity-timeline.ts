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

export type FactoryStageComment = { threadId: string; messageId: string }

/** The stage writer shares its Yjs thread with genuine replies. Only its exact
 * message identities belong to Factory progress instead of Task discussion. */
export function taskActivityThreads(threads: readonly ThreadRecord[], stageComments: readonly FactoryStageComment[]): readonly ThreadRecord[] {
  if (!stageComments.length) return threads
  const byThread = new Map<string, Set<string>>()
  for (const { threadId, messageId } of stageComments) {
    const ids = byThread.get(threadId)
    if (ids) ids.add(messageId)
    else byThread.set(threadId, new Set([messageId]))
  }
  return threads.flatMap(thread => {
    const ids = byThread.get(thread.id)
    if (!ids) return [thread]
    const messages = thread.messages.filter(message => !ids.has(message.id))
    if (messages.length === thread.messages.length) return [thread]
    const first = messages[0]
    return first ? [{ ...thread, author: first.author, createdAt: first.at, messages }] : []
  })
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

export function taskActivityFacts(history: readonly IssueActivityEvent[], threads: readonly ThreadRecord[], stageComments: readonly FactoryStageComment[] = []): TaskActivityFact[] {
  return chronologicalActivity<TaskActivityFact>([
    ...history.map(event => ({ kind: 'history' as const, id: `history:${event.id}`, at: event.at, event })),
    ...taskDiscussionEvents(taskActivityThreads(threads, stageComments)),
  ])
}

type HistoryLabels = Pick<typeof import('../messages/en.json')['Workspace']['activity'],
  'unknownAssignee' | 'changedStatus' | 'changedPriority' | 'changedTitle' | 'assigned' | 'delegated' |
  'unassigned' | 'undelegated' | 'addedLabel' | 'removedLabel' | 'addedSubtask'>

/** Both renderers supply their locale; the source event determines the wording. */
export function taskHistoryLabel(event: IssueActivityEvent, labels: {
  created: string
  activity: (key: keyof HistoryLabels, values?: Record<string, string>) => string
  status: (value: string) => string
  priority: (value: string) => string
}) {
  const t = labels.activity
  switch (event.kind) {
    case 'created': return labels.created
    case 'status': return t('changedStatus', { status: labels.status(event.status ?? '') })
    case 'priority': return t('changedPriority', { priority: labels.priority(event.priority ?? '') })
    case 'title': return t('changedTitle', { title: event.title ?? '' })
    case 'assigned': return t(event.assignmentTarget === 'delegate' ? 'delegated' : 'assigned', { name: event.assigneeName || t('unknownAssignee') })
    case 'unassigned': return t(event.assignmentTarget === 'delegate' ? 'undelegated' : 'unassigned')
    case 'labelAdded': return t('addedLabel', { name: event.title ?? '' })
    case 'labelRemoved': return t('removedLabel', { name: event.title ?? '' })
    case 'subtask': return t('addedSubtask', { title: event.title ?? '' })
  }
}
