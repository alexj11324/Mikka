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
  'unknownAssignee' | 'created' | 'changedStatus' | 'changedStatusCode' | 'changedPriority' | 'changedTitle' | 'assigned' | 'delegated' |
  'unassigned' | 'unassignedNamed' | 'undelegated' | 'undelegatedNamed' | 'addedLabel' | 'removedLabel' | 'addedSubtask' | 'addedSubtaskCode'>

/** A clause is words plus the task, thread or pull a word opens. The row paints them; the name is one part at the front. */
export type ActivityPiece =
  | { kind: 'text'; text: string; name?: boolean }
  | { kind: 'task'; text: string; taskId: string }
  | { kind: 'thread'; text: string; runId: string }
  | { kind: 'pull'; text: string; href: string }

/** The task the page is showing, so 「创建了 {编号}」 and 「把 {编号} 改成了」 can name it. */
export type ActivitySubject = { taskId: string; code: string | null }

/** One Agent stretch on this task. `linked` is false when that run has no conversation to open. */
export type ActivityStretch = { at: string; runId: string; agentId: string | null; linked: boolean }

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

function withTask(rendered: string, text: string, taskId: string): ActivityPiece[] {
  const chunks = rendered.split(CODE)
  const pieces: ActivityPiece[] = []
  chunks.forEach((chunk, index) => {
    if (chunk) pieces.push({ kind: 'text', text: chunk })
    if (index < chunks.length - 1) pieces.push({ kind: 'task', text, taskId })
  })
  return pieces.length ? pieces : words(rendered)
}

/** The clause for one event. The caller's locale supplies the sentence; a code is a task part when this page can open it. */
export function taskHistoryPieces(event: IssueActivityEvent, labels: ActivityLabels, subject?: ActivitySubject | null): ActivityPiece[] {
  const t = labels.activity
  const own = subject?.code && subject.taskId ? { code: subject.code, taskId: subject.taskId } : null
  switch (event.kind) {
    case 'created': return own ? withTask(t('created', { code: CODE }), own.code, own.taskId) : words(labels.created)
    case 'status': {
      const status = labels.status(event.status ?? '')
      return own ? withTask(t('changedStatusCode', { code: CODE, status }), own.code, own.taskId) : words(t('changedStatus', { status }))
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
      if (event.targetId && event.code) return withTask(t('addedSubtaskCode', { code: CODE }), event.code, event.targetId)
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
 * The uniquely matching Agent stretch at the event time. Issue versions store actor identity,
 * not a run id; if time would have to choose among this Agent's runs, keep the name plain.
 */
export function activityRunId(at: string, actor: { type?: string | null; id?: string | null } | null | undefined, stretches: readonly ActivityStretch[]): string | null {
  if (actor?.type !== 'agent' || !actor.id) return null
  const time = Date.parse(at)
  if (Number.isNaN(time)) return null
  const ordered = stretches.map(stretch => ({ stretch, time: Date.parse(stretch.at) }))
    .filter(item => Number.isFinite(item.time))
    .sort((a, b) => a.time - b.time || a.stretch.runId.localeCompare(b.stretch.runId))
  let active = -1
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].time <= time) active = index
    else break
  }
  if (active < 0) return null
  // Equal start times or multiple preceding stretches for the same actor leave the run ambiguous.
  if ((active > 0 && ordered[active - 1].time === ordered[active].time) ||
      (active + 1 < ordered.length && ordered[active + 1].time === ordered[active].time)) return null
  const candidate = ordered[active].stretch
  if (!candidate.linked || candidate.agentId !== actor.id) return null
  const actorMatches = ordered.filter(item => item.time <= time && item.stretch.agentId === actor.id)
  return actorMatches.length === 1 ? candidate.runId : null
}

/** One row: the name once, then each clause joined by the locale's separator. The name is a thread part only when a run matches. */
export function activityLineParts(
  events: readonly IssueActivityEvent[],
  labels: ActivityLabels,
  subject: ActivitySubject | null | undefined,
  separator: string,
  actor: { type?: string | null; id?: string | null; name?: string | null } | null | undefined,
  stretches: readonly ActivityStretch[] = [],
): ActivityPiece[] {
  const clause = events.flatMap((event, index) => [
    ...(index ? words(separator) : []),
    ...taskHistoryPieces(event, labels, subject),
  ])
  const name = actor?.name || null
  if (!name) return clause
  const runId = activityRunId(events[0]?.at ?? '', actor, stretches)
  const lead: ActivityPiece = runId ? { kind: 'thread', text: name, runId } : { kind: 'text', text: name, name: true }
  return [lead, { kind: 'text', text: ' ' }, ...clause]
}
