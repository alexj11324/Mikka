import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import type { TaskPresentation } from './task-presentation'
import type { TaskGroup } from './task-state'

export type CollectionIssue = Awaited<ReturnType<typeof listIssues>>[number]
export type CollectionRow = TaskPresentation & { issue: CollectionIssue; current: Thread | null; attempts: number }
export type CollectionGroups = Record<TaskGroup, CollectionRow[]>

/** A presentation is already scoped to the reader, workspace and current Factory.
 * A Bot's dispatched list only narrows membership. Its older Run never changes
 * the Task's global state or attributes another Bot's work to the selected Bot. */
export function groupPresentedTasks(issues: readonly CollectionIssue[], threads: readonly Thread[],
  presentations: Readonly<Record<string, TaskPresentation>>, scope: 'workspace' | 'dispatched'): CollectionGroups {
  const newest = new Map<string, Thread>(), counts = new Map<string, number>()
  for (const thread of threads) {
    const id = thread.issueId
    if (!id) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
    const old = newest.get(id)
    if (!old || thread.createdAt > old.createdAt || (thread.createdAt === old.createdAt && thread.id > old.id)) newest.set(id, thread)
  }
  const groups: CollectionGroups = { pending: [], running: [], todo: [], done: [] }
  for (const issue of issues) {
    const presentation = presentations[issue.id]
    if (!presentation) continue
    const current = newest.get(issue.id) ?? null
    if (!current && scope === 'dispatched') continue
    groups[presentation.group].push({ ...presentation, issue, current, attempts: counts.get(issue.id) ?? 0 })
  }
  return groups
}

export function waitingTasks<Q extends { issueId: string | null }>(groups: CollectionGroups, questions: readonly Q[]) {
  const asked = new Set(questions.map(question => question.issueId))
  return groups.pending.filter(row => row.state === 'waiting' && !asked.has(row.issue.id))
}
