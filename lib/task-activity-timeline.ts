import type { ActivityActorView } from './activity-actor-view'
import type { ThreadRecord } from './task-discussion'

export type IssueActivityEvent = {
  id: string
  at: string
  /** Capy's issue events, as they apply to a task (labels are not an activity event in Capy). */
  kind: 'created' | 'status' | 'priority' | 'title' | 'description' | 'assigned' | 'unassigned' | 'subtask' | 'parent' | 'relation' | 'pull' | 'unsupported' | 'dueDateChanged' | 'projectChanged' | 'estimateChanged'
  status?: string
  priority?: string
  title?: string
  /** The other task a clause names (a sub-task, the parent, a related task). Absent when it is about the page's own task. */
  targetId?: string
  /** That task's identifier, when the event itself knows it. */
  code?: string
  dueDate?: string | null
  estimate?: number | null
  assigneeName?: string
  /** Kept for data: a delegate is said the same way as an assignee, as Capy's assignees include its threads. */
  assignmentTarget?: 'delegate'
  /** `relation`: which relation, and whether it was removed. `parent`: removed when `targetId` is absent. */
  relation?: 'blockedBy' | 'related'
  removed?: boolean
  /** `pull`: the pull request the clause names and what happened to it. */
  pull?: { label: string; href: string; title?: string; action: 'linked' | 'unlinked' | 'merged' }
  source?: { kind: 'revision'; id: string; revision: number; runId?: string | null } | { kind: 'subtask'; id: string }
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

type ActivityDiscussion = { id: string; thread: ThreadRecord; actor?: 'bot' }

/** A stage has one Bot-written comment. Older stages share a Yjs thread:
 * retain the actual reply target; legacy replies follow document order.
 * Only the recorded source pair identifies a Bot update. */
export function taskActivityThreads(threads: readonly ThreadRecord[], stageComments: readonly FactoryStageComment[] = []): ActivityDiscussion[] {
  const byThread = new Map<string, Set<string>>()
  for (const { threadId, messageId } of stageComments) {
    const ids = byThread.get(threadId)
    if (ids) ids.add(messageId)
    else byThread.set(threadId, new Set([messageId]))
  }
  return threads.flatMap(thread => {
    const ids = byThread.get(thread.id)
    if (!ids || !thread.messages.some(message => ids.has(message.id))) return [{ id: thread.id, thread }]
    const groups: ActivityDiscussion[] = []
    const stages = new Map<string, ActivityDiscussion>()
    for (const message of thread.messages) {
      const isStage = ids.has(message.id)
      const target = message.replyToMessageId ? stages.get(message.replyToMessageId) : undefined
      const previous = target ?? groups.at(-1)
      if (previous && !isStage) {
        previous.thread.messages.push(message)
        continue
      }
      const group: ActivityDiscussion = {
        id: isStage ? `discussion:${thread.id}:${message.id}` : thread.id,
        thread: { ...thread, author: message.author, createdAt: message.at, messages: [message] },
        ...(isStage ? { actor: 'bot' } : {}),
      }
      groups.push(group)
      if (isStage) stages.set(message.id, group)
    }
    return groups
  })
}

export type TaskDiscussionEvent = {
  actor?: 'bot'
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
export function taskDiscussionEvents(discussion: ActivityDiscussion | readonly ThreadRecord[]): TaskDiscussionEvent[] {
  if (!('thread' in discussion)) return discussion.flatMap(thread => taskDiscussionEvents({ id: thread.id, thread }))
  const { thread } = discussion
  return thread.messages.map((message, i) => ({
    ...(i === 0 && discussion.actor ? { actor: discussion.actor } : {}),
    kind: i === 0 ? 'comment' as const : 'reply' as const,
    id: `discussion:${thread.id}:${message.id}`, threadId: thread.id, messageId: message.id,
    author: message.author, authorId: message.authorUserId ?? null,
    body: message.body, at: message.at, resolved: thread.resolved,
  }))
}

export function taskActivityFacts(history: readonly IssueActivityEvent[], threads: readonly ThreadRecord[], stageComments: readonly FactoryStageComment[] = []): TaskActivityFact[] {
  return chronologicalActivity<TaskActivityFact>([
    ...history.map(event => ({ kind: 'history' as const, id: `history:${event.id}`, at: event.at, event })),
    ...taskActivityThreads(threads, stageComments).flatMap(taskDiscussionEvents),
  ])
}

type HistoryLabels = Pick<typeof import('../messages/en.json')['Workspace']['activity'],
  'created' | 'createdTask' | 'moved' | 'movedTask' | 'setPriority' | 'renamed' | 'editedDescription' | 'assigned' | 'unassigned' | 'unassignedTask' |
  'someone' | 'setParent' | 'removedParent' | 'aTask' | 'addedSubtask' | 'markedBlockedBy' | 'markedRelated' | 'removedRelation' | 'linked' | 'unlinked' |
  'merged' | 'unsupported' | 'system' | 'untitledThread' | 'dueDateChanged' | 'dueDateRemoved' | 'projectChanged' | 'projectRemoved' | 'estimateChanged' | 'estimateRemoved'>

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
export type ActivityStretch = { at: string; runId: string; agentId: string | null; linked: boolean } & RunPreview

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
    case 'dueDateChanged': return words(event.dueDate ? t('dueDateChanged', { date: event.dueDate }) : t('dueDateRemoved'))
    case 'projectChanged': return words(event.title ? t('projectChanged', { name: event.title }) : t('projectRemoved'))
    case 'estimateChanged': return words(event.estimate !== null && event.estimate !== undefined ? t('estimateChanged', { estimate: String(event.estimate) }) : t('estimateRemoved'))
    case 'unsupported': return words(t('unsupported'))
  }
}

/** The sentence as plain words, for a reader with no chips (iOS, a notification). */
export function taskHistoryLabel(event: IssueActivityEvent, labels: ActivityLabels, subject?: ActivitySubject | null) {
  return taskHistoryPieces(event, labels, subject).map(piece => piece.text).join('')
}

/** Only a run recorded on the source event can identify its conversation. A unique
 * timestamp/actor match is still a guess: an Agent can write outside a run. */
export function activityStretch(_at: string, actor: { type?: string | null; id?: string | null } | null | undefined, stretches: readonly ActivityStretch[], sourceRunId?: string | null): ActivityStretch | null {
  if (actor?.type !== 'agent' || !actor.id || !sourceRunId) return null
  const matches = stretches.filter(stretch => stretch.runId === sourceRunId && stretch.agentId === actor.id && stretch.linked)
  return matches.length === 1 ? matches[0] : null
}

export function activityRunId(at: string, actor: { type?: string | null; id?: string | null } | null | undefined, stretches: readonly ActivityStretch[], sourceRunId?: string | null): string | null {
  return activityStretch(at, actor, stretches, sourceRunId)?.runId ?? null
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
    const stretch = activityStretch(event.at, actor, stretches, event.source?.kind === 'revision' ? event.source.runId : null)
    lead = stretch
      ? { kind: 'thread', text: stretch.title || t('untitledThread'), runId: stretch.runId, ...defined({ harness: stretch.harness, title: stretch.title, result: stretch.result, time: stretch.time }) }
      : { kind: 'text', text: t('untitledThread'), name: true }
  } else if (actor?.type === 'user' && actor.name) lead = { kind: 'text', text: actor.name, name: true }
  else lead = { kind: 'text', text: t('system'), name: true }
  return [lead, { kind: 'text', text: ' ' }, ...clause]
}
