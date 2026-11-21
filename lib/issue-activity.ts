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
  sourceRunId?: string | null
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

/** Older activity snapshots carried a fingerprint alongside the document attributes. */
function bodyHash(content: JSONContent): string | null {
  const hash = (content as JSONContent & { bodyHash?: unknown }).bodyHash
  return typeof hash === 'string' ? hash : null
}

/** github.com/owner/repo/pull/12 → repo#12, as Capy names a pull request in a sentence. */
export function pullLabel(url: string) {
  const match = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url)
  return match ? `${match[1]}#${match[2]}` : url
}

/** Turns stored versions and current subtasks into Capy's issue events, one per change. */
export function deriveIssueActivity(versions: ActivityVersion[], children: ActivityChild[], limit = 12, predecessor?: ActivityVersion | null): IssueActivityEvent[] {
  const ordered = [...versions, ...(predecessor ? [predecessor] : [])].sort((a, b) => a.revision - b.revision)
  const events: IssueActivityEvent[] = []
  // A predecessor supplies comparison context, not a visible activity row.
  const created = versions.find(version => version.revision === 1)
  if (created) events.push({ source: { kind: 'revision', id: created.id, revision: 1, runId: created.sourceRunId ?? null }, id: `created-${created.id}`, at: timestamp(created.createdAt), kind: 'created', actorKey: actorKeyOf(created), actor: created.actor ?? null })
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
    const add = (event: IssueActivityEvent) => versionEvents.push({ ...event, source: { kind: 'revision', id: current.id, revision: current.revision, runId: current.sourceRunId ?? null } })
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
    if (beforeMetadata.parentId !== afterMetadata.parentId) {
      add(afterMetadata.parentId
        ? { id: `parent-${current.id}`, at, actorKey, actor, kind: 'parent', targetId: afterMetadata.parentId }
        : { id: `parent-${current.id}`, at, actorKey, actor, kind: 'parent', removed: true })
    }
    for (const [relation, field] of [['blockedBy', 'blockedByIds'], ['related', 'relatedIds']] as const) {
      const was = new Set(beforeMetadata[field])
      const now = new Set(afterMetadata[field])
      for (const id of now) if (!was.has(id)) add({ id: `relation-${current.id}-${relation}-${id}`, at, actorKey, actor, kind: 'relation', relation, targetId: id })
      for (const id of was) if (!now.has(id)) add({ id: `relation-off-${current.id}-${relation}-${id}`, at, actorKey, actor, kind: 'relation', relation, targetId: id, removed: true })
    }
    const pullsBefore = new Map(beforeMetadata.pullRequests.map(pull => [pull.url.replace(/\/$/, ''), pull]))
    const pullsAfter = new Map(afterMetadata.pullRequests.map(pull => [pull.url.replace(/\/$/, ''), pull]))
    const pull = (url: string, title: string | undefined, action: 'linked' | 'unlinked' | 'merged') => ({ label: pullLabel(url), href: url, ...title ? { title } : {}, action })
    for (const [url, item] of pullsAfter) {
      const had = pullsBefore.get(url)
      if (!had) add({ id: `pull-${current.id}-${url}`, at, actorKey, actor, kind: 'pull', pull: pull(url, item.title, 'linked') })
      if (item.state === 'merged' && had?.state !== 'merged') add({ id: `pull-merged-${current.id}-${url}`, at, actorKey, actor, kind: 'pull', pull: pull(url, item.title, 'merged') })
    }
    for (const [url, item] of pullsBefore) if (!pullsAfter.has(url)) add({ id: `pull-off-${current.id}-${url}`, at, actorKey, actor, kind: 'pull', pull: pull(url, item.title, 'unlinked') })
    if (beforeMetadata.dueDate !== afterMetadata.dueDate) add({ id: `due-date-${current.id}`, at, actorKey, actor, kind: 'dueDateChanged', dueDate: afterMetadata.dueDate })
    if (beforeMetadata.project !== afterMetadata.project) add({ id: `project-${current.id}`, at, actorKey, actor, kind: 'projectChanged', title: afterMetadata.project ?? undefined })
    if (beforeMetadata.estimate !== afterMetadata.estimate) add({ id: `estimate-${current.id}`, at, actorKey, actor, kind: 'estimateChanged', estimate: afterMetadata.estimate })
    let descriptionEventIndex: number | null = null
    // Older Activity snapshots contained fingerprints. New SQL projections expose only the change bit.
    const beforeBody = bodyHash(previous.content)
    const afterBody = bodyHash(current.content)
    const changed = current.descriptionChanged ?? (beforeBody !== null && afterBody !== null && beforeBody !== afterBody)
    if (changed) {
      const descriptionEvent: IssueActivityEvent = { id: `description-${current.id}`, at, actorKey, actor, kind: 'description', source: { kind: 'revision', id: current.id, revision: current.revision, runId: current.sourceRunId ?? null } }
      if (versionEvents.length === 0 && previousDescription?.revision === previous.revision && previousDescription.actorKey === actorKey) {
        descriptionEventIndex = previousDescription.eventIndex
        events[descriptionEventIndex] = descriptionEvent
      } else {
        versionEvents.push(descriptionEvent)
      }
    }
    events.push(...versionEvents)
    const descriptionOnly: boolean = descriptionEventIndex !== null || versionEvents.length === 1 && versionEvents[0].kind === 'description'
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

/** A thread the issue dispatched, as the activity timeline needs it. */
export type ActivityThread = { id: string; createdAt: Date | string }

export type ActivityTimelineRow<T extends ActivityThread> =
  | { type: 'events'; id: string; at: string; events: IssueActivityEvent[] }
  | { type: 'thread'; id: string; at: string; thread: T }

/**
 * One time-ordered activity list (#1264): task events and dispatched threads interleave by when they happened, one
 * event per row, as Capy's log. Ties keep a stable order: task events before threads, then by id.
 */
export function activityTimeline<T extends ActivityThread>(events: IssueActivityEvent[], threads: T[]): ActivityTimelineRow<T>[] {
  const items = [
    ...events.map(event => ({ at: event.at, rank: 0, id: event.id, event })),
    ...threads.map(thread => ({ at: timestamp(thread.createdAt), rank: 1, id: thread.id, thread })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.rank - b.rank || a.id.localeCompare(b.id))
  const rows: ActivityTimelineRow<T>[] = []
  for (const item of items) {
    if ('thread' in item) { rows.push({ type: 'thread', id: `thread-${item.id}`, at: item.at, thread: item.thread }); continue }
    rows.push({ type: 'events', id: item.event.id, at: item.at, events: [item.event] })
  }
  return rows
}
