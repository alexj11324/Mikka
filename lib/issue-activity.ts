import type { IssueActivityEvent } from './task-activity-timeline'
export type { IssueActivityEvent } from './task-activity-timeline'
import type { ActivityActorView } from './activity-actor-view'
import type { JSONContent } from '@tiptap/core'
import { readIssueMetadata } from '@/lib/issue-metadata'

export type ActivityVersion = {
  id: string
  revision: number
  title: string
  status: string
  priority: string
  content: JSONContent
  /** Who made the change (server-set); null on rows from before MIK-17. */
  actorType?: 'user' | 'agent' | 'system' | null
  actorId?: string | null
  actor?: ActivityActorView | null
  /** Computed in SQL without sending document text or a digest to the client. */
  descriptionChanged?: boolean
  createdAt: Date | string
}

export type ActivityChild = {
  id: string
  title: string
  identifier?: string | null
  createdAt: Date | string
}

function actorKeyOf(version: ActivityVersion) {
  return version.actorType ? `${version.actorType}:${version.actorId ?? ''}` : null
}

function timestamp(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function legacyDelegate(content: JSONContent): boolean {
  const metadata = content.attrs?.mikka ?? content.attrs?.orvilo
  return Boolean(metadata && typeof metadata === 'object' && !Object.hasOwn(metadata, 'delegate') && metadata.assignee?.kind === 'agent')
}

function sameDelegate(before: ReturnType<typeof readIssueMetadata>['delegate'], after: ReturnType<typeof readIssueMetadata>['delegate'], previous: JSONContent, current: JSONContent) {
  if (!before || !after) return before === after
  if (before.id !== after.id) return false
  if (before.kind === after.kind) return true
  // Old Bot references used assignee.kind=agent. Their migration to an
  // explicit Bot delegate is a representation change, not a new delegation.
  return (legacyDelegate(previous) && after.kind === 'bot') || (legacyDelegate(current) && before.kind === 'bot')
}

function labelNames(content: JSONContent) {
  return readIssueMetadata(content).labels.map(label => label.name)
}

/** Turns stored versions and current subtasks into a short, human activity list. Description-only autosaves are omitted. */
export function deriveIssueActivity(versions: ActivityVersion[], children: ActivityChild[], limit = 12): IssueActivityEvent[] {
  const ordered = [...versions].sort((a, b) => a.revision - b.revision)
  const events: IssueActivityEvent[] = []
  const created = ordered.find(version => version.revision === 1)
  if (created) events.push({ source: { kind: 'revision', id: created.id, revision: 1 }, id: `created-${created.id}`, at: timestamp(created.createdAt), kind: 'created', actorKey: actorKeyOf(created), actor: created.actor ?? null })
  let previousDescription: { revision: number; actorKey: string | null; eventIndex: number } | null = null
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    // A bounded activity window can include the original creation and then a later page.
    // A gap cannot attribute every intervening edit to the first actor on that page.
    if (current.revision !== previous.revision + 1) continue
    const at = timestamp(current.createdAt)
    const actorKey = actorKeyOf(current)
    const actor = current.actor ?? null
    const versionEvents: IssueActivityEvent[] = []
    const add = (event: IssueActivityEvent) => versionEvents.push({ ...event, source: { kind: 'revision', id: current.id, revision: current.revision } })
    if (current.status !== previous.status) add({ id: `status-${current.id}`, at, actorKey, actor, kind: 'status', status: current.status })
    if (current.priority !== previous.priority) add({ id: `priority-${current.id}`, at, actorKey, actor, kind: 'priority', priority: current.priority })
    if (current.title !== previous.title) add({ id: `title-${current.id}`, at, actorKey, actor, kind: 'title', title: current.title })
    const beforeMetadata = readIssueMetadata(previous.content)
    const afterMetadata = readIssueMetadata(current.content)
    const before = beforeMetadata.assignee
    const after = afterMetadata.assignee
    if ((before?.id ?? null) !== (after?.id ?? null)) {
      if (after) add({ id: `assign-${current.id}`, at, actorKey, actor, kind: 'assigned', assigneeName: after.name })
      else add({ id: `unassign-${current.id}`, at, actorKey, actor, kind: 'unassigned', assigneeName: before?.name })
    }
    if (!sameDelegate(beforeMetadata.delegate, afterMetadata.delegate, previous.content, current.content)) {
      if (afterMetadata.delegate) add({ id: `delegate-assign-${current.id}`, at, actorKey, actor, kind: 'assigned', assignmentTarget: 'delegate', assigneeName: afterMetadata.delegate.name })
      else add({ id: `delegate-unassign-${current.id}`, at, actorKey, actor, kind: 'unassigned', assignmentTarget: 'delegate', assigneeName: beforeMetadata.delegate?.name })
    }
    const beforeLabels = new Set(labelNames(previous.content))
    const afterLabels = new Set(labelNames(current.content))
    for (const name of afterLabels) {
      if (!beforeLabels.has(name)) add({ id: `label-add-${current.id}-${name}`, at, actorKey, actor, kind: 'labelAdded', title: name })
    }
    for (const name of beforeLabels) {
      if (!afterLabels.has(name)) add({ id: `label-remove-${current.id}-${name}`, at, actorKey, actor, kind: 'labelRemoved', title: name })
    }
    const relationEvents = (before: string[], after: string[], added: 'blockerAdded' | 'relatedAdded', removed: 'blockerRemoved' | 'relatedRemoved') => {
      const beforeSet = new Set(before), afterSet = new Set(after)
      for (const id of afterSet) if (!beforeSet.has(id)) add({ id: `${added}-${current.id}-${id}`, at, actorKey, actor, kind: added, targetId: id })
      for (const id of beforeSet) if (!afterSet.has(id)) add({ id: `${removed}-${current.id}-${id}`, at, actorKey, actor, kind: removed, targetId: id })
    }
    relationEvents(beforeMetadata.blockedByIds, afterMetadata.blockedByIds, 'blockerAdded', 'blockerRemoved')
    relationEvents(beforeMetadata.relatedIds, afterMetadata.relatedIds, 'relatedAdded', 'relatedRemoved')
    if (beforeMetadata.parentId !== afterMetadata.parentId) add({ id: `parent-${current.id}`, at, actorKey, actor, kind: 'parentChanged', targetId: afterMetadata.parentId ?? beforeMetadata.parentId ?? undefined })
    if (beforeMetadata.dueDate !== afterMetadata.dueDate) add({ id: `due-date-${current.id}`, at, actorKey, actor, kind: 'dueDateChanged', dueDate: afterMetadata.dueDate })
    if (beforeMetadata.project !== afterMetadata.project) add({ id: `project-${current.id}`, at, actorKey, actor, kind: 'projectChanged', title: afterMetadata.project ?? undefined })
    if (beforeMetadata.estimate !== afterMetadata.estimate) add({ id: `estimate-${current.id}`, at, actorKey, actor, kind: 'estimateChanged', estimate: afterMetadata.estimate })
    let descriptionEventIndex: number | null = null
    if (current.descriptionChanged) {
      const descriptionEvent: IssueActivityEvent = { id: `description-${current.id}`, at, actorKey, actor, kind: 'descriptionChanged', source: { kind: 'revision', id: current.id, revision: current.revision } }
      if (versionEvents.length === 0 && previousDescription?.revision === previous.revision && previousDescription.actorKey === actorKey) {
        descriptionEventIndex = previousDescription.eventIndex
        events[descriptionEventIndex] = descriptionEvent
      } else {
        versionEvents.push(descriptionEvent)
      }
    }
    events.push(...versionEvents)
    const descriptionOnly: boolean = descriptionEventIndex !== null || versionEvents.length === 1 && versionEvents[0].kind === 'descriptionChanged'
    previousDescription = descriptionOnly
      ? { revision: current.revision, actorKey, eventIndex: descriptionEventIndex ?? events.length - 1 }
      : null
  }
  const createdAt = created ? Date.parse(timestamp(created.createdAt)) : Number.NEGATIVE_INFINITY
  for (const child of children) {
    const at = timestamp(child.createdAt)
    if (Date.parse(at) + 2000 < createdAt) continue
    events.push({ source: { kind: 'subtask', id: child.id }, id: `subtask-${child.id}`, at, kind: 'subtask', title: child.title, targetId: child.id, ...(child.identifier ? { code: child.identifier } : {}) })
  }
  const createdEvent = events.find(event => event.kind === 'created')
  const rest = events.filter(event => event.kind !== 'created').sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, limit)
  return [...(createdEvent ? [createdEvent] : []), ...rest].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

/**
 * R-63: one person's events in the same minute read as one row
 * (「Ada 创建了 MIK-12，指派给了 Bob」). Rows from before MIK-17 have no actor and
 * group by minute alone; events must already be in time order.
 */
export function groupActivityByMinute(events: IssueActivityEvent[]): IssueActivityEvent[][] {
  const groups: IssueActivityEvent[][] = []
  for (const event of events) {
    const last = groups.at(-1)
    if (last && last[0].at.slice(0, 16) === event.at.slice(0, 16) && (last[0].actorKey ?? null) === (event.actorKey ?? null)) last.push(event)
    else groups.push([event])
  }
  return groups
}

/** A thread the issue dispatched, as the activity timeline needs it. */
export type ActivityThread = { id: string; createdAt: Date | string }

export type ActivityTimelineRow<T extends ActivityThread> =
  | { type: 'events'; id: string; at: string; events: IssueActivityEvent[] }
  | { type: 'thread'; id: string; at: string; thread: T }

/**
 * One time-ordered activity list (#1264): task events and dispatched threads
 * interleave by when they happened. Same-minute events by one actor still
 * read as one row (R-63), but a thread dispatched between them splits it.
 * Ties keep a stable order: task events before threads, then by id.
 */
export function activityTimeline<T extends ActivityThread>(events: IssueActivityEvent[], threads: T[]): ActivityTimelineRow<T>[] {
  const items = [
    ...events.map(event => ({ at: event.at, rank: 0, id: event.id, event })),
    ...threads.map(thread => ({ at: timestamp(thread.createdAt), rank: 1, id: thread.id, thread })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.rank - b.rank || a.id.localeCompare(b.id))
  const rows: ActivityTimelineRow<T>[] = []
  for (const item of items) {
    if ('thread' in item) { rows.push({ type: 'thread', id: `thread-${item.id}`, at: item.at, thread: item.thread }); continue }
    const last = rows.at(-1)
    if (last?.type === 'events' && groupActivityByMinute([last.events[0], item.event]).length === 1) last.events.push(item.event)
    else rows.push({ type: 'events', id: item.event.id, at: item.at, events: [item.event] })
  }
  return rows
}
