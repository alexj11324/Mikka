import type { Task, TaskActivity, TaskGroup, TaskState, ThreadGroup } from '@/lib/types'

/**
 * A task list's groups, in order (decisions/2026-11-07-2045 and 2026-11-07-2230): 等待你 is what waits on the person
 * (a reply, an approval, a review, a failed attempt), 进行中 an attempt queued or running, 待办 an open task with
 * nothing running, 已完成 done or cancelled (folded by default).
 */
export const TASK_GROUPS: { id: TaskGroup; title: string }[] = [
  { id: 'pending', title: '等待你' },
  { id: 'running', title: '进行中' },
  { id: 'todo', title: '待办' },
  { id: 'done', title: '已完成' },
]

const CLOSED = new Set(['done', 'canceled', 'duplicate'])

/** A thread's R-52 group as its task's group: 等待你 and 受阻 are 等待你, 空闲 is 待办, 已解决 is 已完成. */
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
 * own fields stand in: closed is 已完成, 受阻 or in review is 等待你, doing is 进行中, anything else 待办.
 */
export function groupOf(task: Pick<Task, 'group' | 'status' | 'blocked'>): TaskGroup {
  if (task.group) return task.group
  if (CLOSED.has(task.status)) return 'done'
  if (task.blocked || task.status === 'review') return 'pending'
  if (task.status === 'doing') return 'running'
  return 'todo'
}

/** What a row shows: its own state's icon (null: the board status's icon) and the grey line's reason. */
export type RowState = { state: TaskState | null; reason: string | null }

const BLOCK_WORD = { question: '等你回复', quota: '额度用完', run: '受阻' } as const

/**
 * A row's state (decisions/2026-11-07-2230): the server's `state` and `reason` when it sends them. Until then they
 * are read from `group`, `blocked` and the board status: a failed attempt is 失败, anything else waiting on the
 * person is 等你处理 with its reason, a running group is 运行中, and the rest show their board status. Waiting on
 * another task, or flagged, is never 等你处理: it keeps its own icon and says why.
 */
export function rowState(task: Pick<Task, 'group' | 'status' | 'blocked' | 'state' | 'reason'>): RowState {
  if (task.state !== undefined) return { state: task.state ?? null, reason: task.reason ?? null }
  const block = task.blocked ?? null
  const elsewhere = block?.reason === 'dependency' ? (block.blocker ? `等 ${block.blocker}` : '等其他任务') : block?.reason === 'flagged' ? '已标记受阻' : null
  const group = groupOf(task)
  if (group === 'pending' && !elsewhere) {
    if (block?.reason === 'failed') return { state: 'failed', reason: '失败' }
    const reason = block && block.reason in BLOCK_WORD ? BLOCK_WORD[block.reason as keyof typeof BLOCK_WORD] : task.status === 'review' ? '待审阅' : null
    return { state: 'waiting', reason }
  }
  if (group === 'running') return { state: 'running', reason: elsewhere }
  return { state: null, reason: elsewhere }
}

/** An attempt in 活动 or a chat card: its own result as a state; a settled one shows done (✓) or open (○). */
export function attemptState(attempt: { group?: ThreadGroup; failed?: boolean; status?: string }): TaskState | 'done' | 'todo' {
  if (attempt.failed || attempt.status === 'failed') return 'failed'
  switch (attempt.group) {
    case 'waiting': case 'blocked': return 'waiting'
    case 'running': return 'running'
    case 'resolved': return 'done'
    case 'idle': return 'todo'
    default: return 'waiting'
  }
}

/** The word for an attempt's state, as 活动 and a chat card say it. */
export const ATTEMPT_WORD: Record<TaskState | 'done' | 'todo', string> = { waiting: '等你处理', failed: '失败', running: '运行中', queued: '排队中', done: '完成', todo: '空闲' }

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

export type Attempt = Extract<TaskActivity, { kind: 'attempt' }>
