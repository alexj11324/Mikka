import type { ActivityActorView } from './activity-actor-view'
import type { ThreadRecord } from './task-discussion'

export type IssueActivityEvent = {
  id: string
  at: string
  /** Capy's issue events, as they apply to a task (labels are not an activity event in Capy). */
  kind: 'created' | 'status' | 'priority' | 'title' | 'description' | 'assigned' | 'unassigned' | 'subtask' | 'parent' | 'relation' | 'pull' | 'unsupported'
  status?: string
  priority?: string
  title?: string
  /** The other task a clause names (a sub-task, the parent, a related task). Absent when it is about the page's own task. */
  targetId?: string
  /** That task's identifier, when the event itself knows it. */
  code?: string
  assigneeName?: string
  /** Kept for data: a delegate is said the same way as an assignee, as Capy's assignees include its threads. */
  assignmentTarget?: 'delegate'
  /** `relation`: which relation, and whether it was removed. `parent`: removed when `targetId` is absent. */
  relation?: 'blockedBy' | 'related'
  removed?: boolean
  /** `pull`: the pull request the clause names and what happened to it. */
  pull?: { label: string; href: string; title?: string; action: 'linked' | 'unlinked' | 'merged' }
  source?: { kind: 'revision'; id: string; revision: number } | { kind: 'subtask'; id: string }
  /** `type:id` of whoever made the change; null for rows from before MIK-17 and for subtasks. */
  actorKey?: string | null
  /** Who made the change, as the server resolved it; the sentence starts with them, as Capy's does. */
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
  'created' | 'createdTask' | 'moved' | 'movedTask' | 'setPriority' | 'renamed' | 'editedDescription' | 'assigned' | 'unassigned' | 'unassignedTask' |
  'someone' | 'setParent' | 'removedParent' | 'aTask' | 'addedSubtask' | 'markedBlockedBy' | 'markedRelated' | 'removedRelation' | 'linked' | 'unlinked' |
  'merged' | 'unsupported' | 'system' | 'untitledThread'>

/** A sentence is words plus the task, conversation or pull request a word opens. */
export type ActivityPiece =
  | { kind: 'text'; text: string; name?: boolean }
  | ({ kind: 'task'; text: string; taskId: string } & TaskPreview)
  | ({ kind: 'thread'; text: string; runId: string } & RunPreview)
  | { kind: 'pull'; text: string; href: string }

/** What a task code's hover card shows, as Capy's: status, priority, title, assignee. */
export type TaskPreview = { title?: string; status?: string; priority?: string; assignee?: string }
/** What a conversation chip's hover card shows, as Capy's thread card: its Agent, its title, how its run ended and when. */
export type RunPreview = { harness?: string; title?: string; result?: string; time?: string }

/** The task the page is showing, and the other tasks this page can name by code (sub-tasks, parent, related). */
export type ActivitySubject = { taskId: string; code: string | null; refs?: Readonly<Record<string, { code: string | null } & TaskPreview>> } & TaskPreview

/** One conversation on this task. `linked` is false when it has no transcript to open. `title` is the conversation's own. */
export type ActivityStretch = { at: string; runId: string; /** The Agent that ran it, when the read carries it: an Agent's change matches only its own threads. */ agentId?: string | null; linked: boolean } & RunPreview

export type ActivityLabels = {
  activity: (key: keyof HistoryLabels, values?: Record<string, string>) => string
  status: (value: string) => string
  priority: (value: string) => string
}

/** A character that cannot appear in a status, title or name, so the translated sentence can be split around a chip. */
const SLOT = '\u0001'

/** The fields that have a value, so a part never carries `undefined` keys. */
function defined<T extends Record<string, string | undefined>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value)) as Partial<T>
}

function words(text: string): ActivityPiece[] {
  return text ? [{ kind: 'text', text }] : []
}

/** Fills each slot of the rendered sentence with its chip, in order. */
function withChips(rendered: string, chips: ActivityPiece[]): ActivityPiece[] {
  const chunks = rendered.split(SLOT)
  const pieces: ActivityPiece[] = []
  chunks.forEach((chunk, index) => {
    if (chunk) pieces.push({ kind: 'text', text: chunk })
    if (index < chunks.length - 1 && chips[index]) pieces.push(chips[index])
  })
  return pieces.length ? pieces : words(rendered)
}

/** The clause for one event, after the actor, in Capy's words. A task code is a chip when this page can name it. */
export function taskHistoryPieces(event: IssueActivityEvent, labels: ActivityLabels, subject?: ActivitySubject | null): ActivityPiece[] {
  const t = labels.activity
  const own: ActivityPiece | null = subject?.code ? { kind: 'task', text: subject.code, taskId: subject.taskId, ...defined({ title: subject.title, status: subject.status, priority: subject.priority, assignee: subject.assignee }) } : null
  const other = (id: string | undefined, code?: string, title?: string): ActivityPiece => {
    const ref = id ? subject?.refs?.[id] : undefined
    const text = ref?.code ?? code
    if (id && text) return { kind: 'task', text, taskId: id, ...defined({ title: ref?.title ?? title, status: ref?.status, priority: ref?.priority, assignee: ref?.assignee }) }
    return { kind: 'text', text: t('aTask') }
  }
  switch (event.kind) {
    case 'created': return own ? withChips(t('created', { code: SLOT }), [own]) : words(t('createdTask'))
    case 'status': {
      const status = labels.status(event.status ?? '')
      return own ? withChips(t('moved', { code: SLOT, status }), [own]) : words(t('movedTask', { status }))
    }
    case 'priority': return words(t('setPriority', { priority: labels.priority(event.priority ?? '') }))
    case 'title': return words(t('renamed', { title: event.title ?? '' }))
    case 'description': return words(t('editedDescription'))
    case 'assigned': return words(t('assigned', { name: event.assigneeName || t('someone') }))
    case 'unassigned': return words(event.assigneeName ? t('unassigned', { name: event.assigneeName }) : t('unassignedTask'))
    case 'parent': return event.removed || !event.targetId ? words(t('removedParent')) : withChips(t('setParent', { code: SLOT }), [other(event.targetId, event.code, event.title)])
    case 'subtask': return withChips(t('addedSubtask', { code: SLOT }), [other(event.targetId, event.code, event.title)])
    case 'relation': {
      const target = other(event.targetId, event.code, event.title)
      if (event.removed) return withChips(t('removedRelation', { other: SLOT }), [target])
      const subjectChip = own ?? { kind: 'text', text: t('aTask') } as ActivityPiece
      return withChips(t(event.relation === 'blockedBy' ? 'markedBlockedBy' : 'markedRelated', { code: SLOT, other: SLOT }), [subjectChip, target])
    }
    case 'pull': {
      if (!event.pull) return words(t('unsupported'))
      const chip: ActivityPiece = { kind: 'pull', text: event.pull.label, href: event.pull.href }
      if (event.pull.action === 'merged') return withChips(t('merged', { pull: SLOT, title: event.pull.title ?? '' }).trim(), [chip])
      return withChips(t(event.pull.action === 'linked' ? 'linked' : 'unlinked', { pull: SLOT }), [chip])
    }
    case 'unsupported': return words(t('unsupported'))
  }
}

/** The sentence as plain words, for a reader with no chips (iOS, a notification). */
export function taskHistoryLabel(event: IssueActivityEvent, labels: ActivityLabels, subject?: ActivitySubject | null) {
  return taskHistoryPieces(event, labels, subject).map(piece => piece.text).join('')
}

/**
 * The conversation that had already started when this Agent change happened: the last one, as Capy names the thread
 * that made the change. A person's change, an unmatched Agent and a conversation with no transcript match nothing.
 */
export function activityStretch(at: string, actor: { type?: string | null; id?: string | null } | null | undefined, stretches: readonly ActivityStretch[]): ActivityStretch | null {
  if (actor?.type !== 'agent') return null
  const time = Date.parse(at)
  if (Number.isNaN(time)) return null
  // Issue history stores who changed it, not which run: an Agent's change matches only its own threads that had
  // started, and when more than one could have made it the thread is not guessed (fail closed, as main's #2538 rule).
  const candidates = stretches.filter(stretch => {
    const started = Date.parse(stretch.at)
    return stretch.linked && !Number.isNaN(started) && started <= time
      && (!actor.id || stretch.agentId === undefined || stretch.agentId === null || stretch.agentId === actor.id)
  })
  return candidates.length === 1 ? candidates[0] : null
}

export function activityRunId(at: string, actor: { type?: string | null } | null | undefined, stretches: readonly ActivityStretch[]): string | null {
  return activityStretch(at, actor, stretches)?.runId ?? null
}

/**
 * One event as Capy writes it: who, then what. A person is their name; an Agent is the conversation it worked in (a chip
 * that opens it); no actor is Mikka. A merged pull request is a line of its own, with no actor, as Capy's PR rows are.
 */
export function activityLineParts(
  event: IssueActivityEvent,
  labels: ActivityLabels,
  subject: ActivitySubject | null | undefined,
  stretches: readonly ActivityStretch[] = [],
): ActivityPiece[] {
  const clause = taskHistoryPieces(event, labels, subject)
  if (event.kind === 'pull' && event.pull?.action === 'merged') return clause
  const actor = event.actor
  const t = labels.activity
  let lead: ActivityPiece
  if (actor?.type === 'agent') {
    const stretch = activityStretch(event.at, actor, stretches)
    lead = stretch
      ? { kind: 'thread', text: stretch.title || t('untitledThread'), runId: stretch.runId, ...defined({ harness: stretch.harness, title: stretch.title, result: stretch.result, time: stretch.time }) }
      // No thread to name, or more than one that could have made it: an untitled thread, never a guessed link
      // and never the Agent's name as the actor (Alex: a change is said by its thread).
      : { kind: 'text', text: t('untitledThread'), name: true }
  } else if (actor?.type === 'user' && actor.name) lead = { kind: 'text', text: actor.name, name: true }
  else lead = { kind: 'text', text: t('system'), name: true }
  return [lead, { kind: 'text', text: ' ' }, ...clause]
}
