import type { Task, TaskGroup, ThreadGroup } from '@/lib/types'

/**
 * A task list's groups, in order (decisions/2026-11-07-2045-tasks-only-threads-inside.md): 待处理 is what waits on
 * the person, 进行中 an attempt queued or running, 待办 an open task with nothing running, 已完成 done or cancelled
 * (folded by default).
 */
export const TASK_GROUPS: { id: TaskGroup; title: string }[] = [
  { id: 'pending', title: '待处理' },
  { id: 'running', title: '进行中' },
  { id: 'todo', title: '待办' },
  { id: 'done', title: '已完成' },
]

const CLOSED = new Set(['done', 'canceled', 'duplicate'])

/** A thread's R-52 group as its task's group: 等待你 and 受阻 are 待处理, 空闲 is 待办, 已解决 is 已完成. */
export function groupOfThread(group: ThreadGroup): TaskGroup {
  switch (group) {
    case 'waiting': case 'blocked': return 'pending'
    case 'running': return 'running'
    case 'idle': return 'todo'
    case 'resolved': return 'done'
  }
}

/**
 * The task's group: the server's, from its current thread (R-52). A server older than that sends none, so the task's
 * own fields stand in: closed is 已完成, 受阻 or in review is 待处理, doing is 进行中, anything else 待办.
 */
export function groupOf(task: Pick<Task, 'group' | 'status' | 'blocked'>): TaskGroup {
  if (task.group) return task.group
  if (CLOSED.has(task.status)) return 'done'
  if (task.blocked || task.status === 'review') return 'pending'
  if (task.status === 'doing') return 'running'
  return 'todo'
}

export type TaskFilter = 'all' | TaskGroup

export type TaskListRow<T> =
  | { kind: 'section'; id: TaskGroup; title: string; count: number; folded: boolean }
  | { kind: 'task'; task: T }

/**
 * The list's rows: each group with tasks gets its header (name, count, fold), then its tasks unless folded. 已完成
 * starts folded; `toggled` holds the groups the person opened or closed. A filter shows that group alone.
 */
export function taskListRows<T extends Pick<Task, 'group' | 'status' | 'blocked'>>(tasks: readonly T[], toggled: ReadonlySet<TaskGroup>, filter: TaskFilter = 'all'): TaskListRow<T>[] {
  return TASK_GROUPS.filter(group => filter === 'all' || group.id === filter).flatMap((group): TaskListRow<T>[] => {
    const items = tasks.filter(task => groupOf(task) === group.id)
    if (!items.length) return []
    const folded = (group.id === 'done') !== toggled.has(group.id)
    return [{ kind: 'section', id: group.id, title: group.title, count: items.length, folded }, ...(folded ? [] : items.map(task => ({ kind: 'task' as const, task })))]
  })
}

/** 「第 N 次尝试 · Agent」, an attempt's header title. */
export const attemptTitle = (n: number, harness: string) => `第 ${n} 次尝试 · ${harness}`
