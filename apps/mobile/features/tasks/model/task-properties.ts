import type { TaskDetail } from '@/lib/types'

type Work = NonNullable<TaskDetail['work']>
type Connection = NonNullable<Work['connections']>[number]
type RelationKind = Connection['kinds'][number]
export type TaskThreadLine = NonNullable<Work['conversations']>[number] & { detail: NonNullable<NonNullable<Work['conversations']>[number]['detail']> }
export type TaskPullLine = { url: string; ref: string | null; title: string | null; state: Work['pullRequests'][number]['state'] }

/**
 * The task's properties in one column under its title, in Capy's order as the web task page draws them
 * (decisions/2026-11-14-2330, R-61): the parent first, then status, priority, assignee, who created it, its pull
 * requests and its threads, then the other relations. A property with nothing set is left out; status, priority and
 * assignee are always there (an empty assignee reads 「无负责人」).
 */
export type TaskProperty =
  | { id: 'status' | 'priority' }
  | { id: 'assignee'; owner: NonNullable<TaskDetail['task']['workOwner']> | null }
  | { id: 'createdBy'; name: string }
  | { id: 'pullRequests'; pulls: TaskPullLine[] }
  | { id: 'threads'; chats: Work['linkedChats']; threads: TaskThreadLine[] }
  | { id: RelationKind; tasks: Pick<Connection, 'id' | 'identifier' | 'title'>[] }

const TRAILING_RELATIONS = ['child', 'blockedBy', 'blocks', 'duplicate', 'related'] as const

/** github.com/owner/repo/pull/12 → repo#12, as Capy names a pull request; null for any other link. */
export function pullRef(url: string) {
  const match = /^https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url)
  return match ? `${match[1]}#${match[2]}` : null
}

/** Whoever made the task's first revision (the actor 活动 starts with); older servers only send the creation's name. */
export function taskCreator(detail: Pick<TaskDetail, 'timeline' | 'activity'>) {
  const created = detail.timeline?.find(item => item.kind === 'history' && item.event.kind === 'created')
  const name = created?.kind === 'history' ? created.event.actor?.name : undefined
  if (name) return name
  const fallback = detail.activity.find(item => item.kind === 'created')
  return fallback?.kind === 'created' ? fallback.by : null
}

export function taskProperties(detail: Pick<TaskDetail, 'task' | 'work' | 'timeline' | 'activity'>): TaskProperty[] {
  const work = detail.work
  const related = (kind: RelationKind): TaskProperty[] => {
    const tasks = (work?.connections ?? []).filter(row => row.kinds.includes(kind)).map(({ id, identifier, title }) => ({ id, identifier, title }))
    return tasks.length ? [{ id: kind, tasks }] : []
  }
  const creator = taskCreator(detail)
  const pulls = (work?.pullRequests ?? []).map(pull => ({ url: pull.url, ref: pullRef(pull.url), title: pull.title?.trim() || null, state: pull.state }))
  // Only conversations this reader may open; the server sends just the task's own threads (review and verify are
  // child threads inside the one they check).
  const threads = (work?.conversations ?? []).filter((thread): thread is TaskThreadLine => Boolean(thread.detail))
  const chats = work?.linkedChats ?? []
  return [
    ...related('parent'),
    { id: 'status' },
    { id: 'priority' },
    { id: 'assignee', owner: detail.task.workOwner ?? null },
    ...creator ? [{ id: 'createdBy', name: creator } as const] : [],
    ...pulls.length ? [{ id: 'pullRequests', pulls } as const] : [],
    ...chats.length || threads.length ? [{ id: 'threads', chats, threads } as const] : [],
    ...TRAILING_RELATIONS.flatMap(related),
  ]
}
