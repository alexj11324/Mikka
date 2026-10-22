import type { JSONContent } from '@tiptap/core'
import { readIssueMetadata } from '@/lib/issue-metadata'

export type ActivityVersion = {
  id: string
  revision: number
  title: string
  status: string
  priority: string
  content: JSONContent
  createdAt: Date | string
}

export type ActivityChild = {
  id: string
  title: string
  createdAt: Date | string
}

export type IssueActivityEvent = {
  id: string
  at: string
  kind: 'created' | 'status' | 'priority' | 'title' | 'assigned' | 'unassigned' | 'subtask'
  status?: string
  priority?: string
  title?: string
  assigneeName?: string
}

function timestamp(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function assigneeOf(content: JSONContent) {
  return readIssueMetadata(content).assignee
}

/** Turns stored versions and current subtasks into a short, human activity list. Description-only autosaves are omitted. */
export function deriveIssueActivity(versions: ActivityVersion[], children: ActivityChild[], limit = 12): IssueActivityEvent[] {
  const ordered = [...versions].sort((a, b) => a.revision - b.revision)
  const events: IssueActivityEvent[] = []
  const created = ordered.find(version => version.revision === 1) ?? ordered[0]
  if (created) events.push({ id: `created-${created.id}`, at: timestamp(created.createdAt), kind: 'created' })
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    const at = timestamp(current.createdAt)
    if (current.status !== previous.status) events.push({ id: `status-${current.id}`, at, kind: 'status', status: current.status })
    if (current.priority !== previous.priority) events.push({ id: `priority-${current.id}`, at, kind: 'priority', priority: current.priority })
    if (current.title !== previous.title) events.push({ id: `title-${current.id}`, at, kind: 'title', title: current.title })
    const before = assigneeOf(previous.content)
    const after = assigneeOf(current.content)
    if ((before?.id ?? null) !== (after?.id ?? null)) {
      if (after) events.push({ id: `assign-${current.id}`, at, kind: 'assigned', assigneeName: after.name })
      else events.push({ id: `unassign-${current.id}`, at, kind: 'unassigned' })
    }
  }
  const createdAt = created ? Date.parse(timestamp(created.createdAt)) : Number.NEGATIVE_INFINITY
  for (const child of children) {
    const at = timestamp(child.createdAt)
    if (Date.parse(at) + 2000 < createdAt) continue
    events.push({ id: `subtask-${child.id}`, at, kind: 'subtask', title: child.title })
  }
  const createdEvent = events.find(event => event.kind === 'created')
  const rest = events.filter(event => event.kind !== 'created').sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, limit)
  return [...(createdEvent ? [createdEvent] : []), ...rest].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}
