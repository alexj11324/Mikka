import type { ActivityActorView } from './activity-actor-view'
import type { ThreadRecord } from './task-discussion'

export type IssueActivityEvent = {
  id: string
  at: string
  kind: 'created' | 'status' | 'priority' | 'title' | 'assigned' | 'unassigned' | 'subtask' | 'labelAdded' | 'labelRemoved'
  status?: string
  priority?: string
  title?: string
  /** Subtask this clause names. Absent when the clause is about the page's own task. */
  targetId?: string
  /** That subtask's identifier, when the sentence shows a code instead of its title. */
  code?: string
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
  'unknownAssignee' | 'created' | 'changedStatus' | 'changedStatusCode' | 'changedPriority' | 'changedTitle' | 'assigned' | 'delegated' |
  'unassigned' | 'unassignedNamed' | 'undelegated' | 'undelegatedNamed' | 'addedLabel' | 'removedLabel' | 'addedSubtask' | 'addedSubtaskCode'>

/** A clause is words plus the task, thread or pull a word opens. The row paints them; the name is one part at the front. */
export type ActivityPiece =
  | { kind: 'text'; text: string; name?: boolean }
  | { kind: 'task'; text: string; taskId: string; title?: string; status?: string }
  | { kind: 'thread'; text: string; runId: string; result?: string }
  | { kind: 'pull'; text: string; href: string }

/** The task the page is showing, so 「创建了 {编号}」 and 「把 {编号} 改成了」 can name it. */
export type ActivitySubject = { taskId: string; code: string | null; title?: string; status?: string }

/** One Agent stretch on this task. `linked` is false when that run has no conversation to open. */
export type ActivityStretch = { at: string; runId: string; linked: boolean; result?: string }

export type ActivityLabels = {
  created: string
  activity: (key: keyof HistoryLabels, values?: Record<string, string>) => string
  status: (value: string) => string
  priority: (value: string) => string
}

/** A character that cannot appear in a status, title or name, so the translated sentence can be split around the code. */
const CODE = '\u0001'

function words(text: string): ActivityPiece[] {
  return text ? [{ kind: 'text', text }] : []
}

/** `about` is what a hover preview shows for that task: its title and status, when this page knows them. */
function withTask(rendered: string, text: string, taskId: string, about: { title?: string; status?: string } = {}): ActivityPiece[] {
  const chunks = rendered.split(CODE)
  const pieces: ActivityPiece[] = []
  chunks.forEach((chunk, index) => {
    if (chunk) pieces.push({ kind: 'text', text: chunk })
    if (index < chunks.length - 1) pieces.push({ kind: 'task', text, taskId, ...about.title ? { title: about.title } : {}, ...about.status ? { status: about.status } : {} })
  })
  return pieces.length ? pieces : words(rendered)
}

/** The clause for one event. The caller's locale supplies the sentence; a code is a task part when this page can open it. */
export function taskHistoryPieces(event: IssueActivityEvent, labels: ActivityLabels, subject?: ActivitySubject | null): ActivityPiece[] {
  const t = labels.activity
  const own = subject?.code && subject.taskId ? { code: subject.code, taskId: subject.taskId, about: { title: subject.title, status: subject.status } } : null
  switch (event.kind) {
    case 'created': return own ? withTask(t('created', { code: CODE }), own.code, own.taskId, own.about) : words(labels.created)
    case 'status': {
      const status = labels.status(event.status ?? '')
      return own ? withTask(t('changedStatusCode', { code: CODE, status }), own.code, own.taskId, own.about) : words(t('changedStatus', { status }))
    }
    case 'priority': return words(t('changedPriority', { priority: labels.priority(event.priority ?? '') }))
    case 'title': return words(t('changedTitle', { title: event.title ?? '' }))
    case 'assigned': return words(t(event.assignmentTarget === 'delegate' ? 'delegated' : 'assigned', { name: event.assigneeName || t('unknownAssignee') }))
    case 'unassigned': {
      const name = event.assigneeName
      if (event.assignmentTarget === 'delegate') return words(name ? t('undelegatedNamed', { name }) : t('undelegated'))
      return words(name ? t('unassignedNamed', { name }) : t('unassigned'))
    }
    case 'labelAdded': return words(t('addedLabel', { name: event.title ?? '' }))
    case 'labelRemoved': return words(t('removedLabel', { name: event.title ?? '' }))
    case 'subtask': {
      if (event.targetId && event.code) return withTask(t('addedSubtaskCode', { code: CODE }), event.code, event.targetId, { title: event.title })
      if (event.targetId && event.title) return withTask(t('addedSubtask', { title: CODE }), event.title, event.targetId)
      return words(t('addedSubtask', { title: event.title ?? '' }))
    }
  }
}

/** Both renderers supply their locale; the source event determines the wording. */
export function taskHistoryLabel(event: IssueActivityEvent, labels: ActivityLabels, subject?: ActivitySubject | null) {
  return taskHistoryPieces(event, labels, subject).map(piece => piece.text).join('')
}

/**
 * The last linked Agent stretch that had already started when this event happened.
 * A person's name, an unmatched Agent and a run with no conversation stay text.
 */
export function activityRunId(at: string, actor: { type?: string | null } | null | undefined, stretches: readonly ActivityStretch[]): string | null {
  return activityStretch(at, actor, stretches)?.runId ?? null
}

/** The stretch itself, so the name's hover preview can say how that run ended. */
export function activityStretch(at: string, actor: { type?: string | null } | null | undefined, stretches: readonly ActivityStretch[]): ActivityStretch | null {
  if (actor?.type !== 'agent') return null
  const time = Date.parse(at)
  if (Number.isNaN(time)) return null
  let match: ActivityStretch | null = null
  const ordered = [...stretches].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.runId.localeCompare(b.runId))
  for (const stretch of ordered) {
    const started = Date.parse(stretch.at)
    if (stretch.linked && !Number.isNaN(started) && started <= time) match = stretch
  }
  return match
}

/** One row: the name once, then each clause joined by the locale's separator. The name is a thread part only when a run matches. */
export function activityLineParts(
  events: readonly IssueActivityEvent[],
  labels: ActivityLabels,
  subject: ActivitySubject | null | undefined,
  separator: string,
  actor: { type?: string | null; name?: string | null } | null | undefined,
  stretches: readonly ActivityStretch[] = [],
): ActivityPiece[] {
  const clause = events.flatMap((event, index) => [
    ...(index ? words(separator) : []),
    ...taskHistoryPieces(event, labels, subject),
  ])
  const name = actor?.name || null
  if (!name) return clause
  const stretch = activityStretch(events[0]?.at ?? '', actor, stretches)
  const lead: ActivityPiece = stretch ? { kind: 'thread', text: name, runId: stretch.runId, ...stretch.result ? { result: stretch.result } : {} } : { kind: 'text', text: name, name: true }
  return [lead, { kind: 'text', text: ' ' }, ...clause]
}
