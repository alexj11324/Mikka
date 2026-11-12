import { mobileMessages } from '@/lib/messages'
import type { Task, TaskGroup, TaskReason, TaskState, ThreadGroup } from '@/lib/types'

/**
 * A task list's groups, in order (decisions/2026-11-07-2045 and 2026-11-07-2230): 等待你 is what waits on the person
 * (a reply, an approval, a review, a failed attempt), 进行中 an attempt queued or running, 待办 an open task with
 * nothing running, 已完成 done or cancelled (folded by default).
 */
export const TASK_GROUPS: { id: TaskGroup; title: string }[] = [
  { id: 'pending', title: mobileMessages.MobileCore.groups.pending },
  { id: 'running', title: mobileMessages.MobileCore.groups.running },
  { id: 'todo', title: mobileMessages.MobileCore.groups.todo },
  { id: 'done', title: mobileMessages.MobileCore.groups.done },
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

/** The grey line's words for the API's reason codes; the app owns the wording. */
export function reasonWord(reason: TaskReason, blockedBy?: string | null): string {
  switch (reason) {
    case 'needs_input': return mobileMessages.MobileCore.reasons.needs_input
    case 'approval': return mobileMessages.MobileCore.reasons.approval
    case 'pr_review': return mobileMessages.MobileCore.reasons.pr_review
    case 'blocked': return mobileMessages.MobileCore.reasons.blocked
    case 'quota': return mobileMessages.MobileCore.reasons.quota
    case 'offline': return mobileMessages.Devices.offline
    case 'blocked_by': return blockedBy ? mobileMessages.MobileCore.reasons.blocked_by.replace('{task}', blockedBy) : mobileMessages.MobileCore.reasons.otherTask
    case 'flagged': return mobileMessages.MobileCore.reasons.flagged
  }
}

const ATTEMPT_STATES = new Set<string>(['waiting', 'failed', 'blocked', 'running', 'queued'])

/**
 * A row's state (decisions/2026-11-07-2230): the API's `state` and `reason` when it sends them; todo, done, canceled
 * and duplicate show the board's icon (null here). A failed attempt's grey line says 失败. Until the server sends
 * them they are read from `group`, `blocked` and the board status: a failed attempt is 失败, anything else waiting
 * on the person is 等你处理 with its reason, a running group is 运行中, and the rest show their board status.
 * Waiting on another task, or flagged, is never 等你处理: it keeps its own icon and says why.
 */
export function rowState(task: Pick<Task, 'group' | 'status' | 'blocked' | 'state' | 'reason' | 'blockedBy'>): RowState {
  if (task.state !== undefined && task.state !== null) {
    const state = ATTEMPT_STATES.has(task.state) ? task.state as TaskState : null
    return { state, reason: state === 'failed' ? mobileMessages.MobileCore.states.failed : task.reason ? reasonWord(task.reason, task.blockedBy) : null }
  }
  const block = task.blocked ?? null
  const elsewhere = block?.reason === 'dependency' ? reasonWord('blocked_by', block.blocker) : block?.reason === 'flagged' ? reasonWord('flagged') : null
  const group = groupOf(task)
  if (group === 'pending' && !elsewhere) {
    if (block?.reason === 'failed') return { state: 'failed', reason: mobileMessages.MobileCore.states.failed }
    // 受阻 is its own state (quota, login, key, a device offline): the octagon, not the hand.
    if (block?.reason === 'quota') return { state: 'blocked', reason: reasonWord('quota') }
    if (block?.reason === 'run') return { state: 'blocked', reason: reasonWord('blocked') }
    return { state: 'waiting', reason: block?.reason === 'question' ? reasonWord('needs_input') : task.status === 'review' ? reasonWord('pr_review') : null }
  }
  if (group === 'running') return { state: 'running', reason: elsewhere }
  return { state: null, reason: elsewhere }
}

/**
 * An attempt's own result, in 活动 and on a chat card (2026-11-07). The hand is the task's, never an attempt's: a
 * paused attempt waiting for the person is a pause, a finished one a check, a failed one a triangle, a blocked one an
 * octagon. The API's own attempt state wins; an older server's is read from the thread group.
 */
export type AttemptResult = 'running' | 'paused' | 'done' | 'failed' | 'blocked'

export function attemptState(attempt: { group?: ThreadGroup; failed?: boolean; status?: string; state?: 'running' | 'waiting' | 'failed' | 'blocked' | 'done' }): AttemptResult {
  if (attempt.state) return attempt.state === 'waiting' ? 'paused' : attempt.state
  if (attempt.failed || attempt.status === 'failed') return 'failed'
  switch (attempt.group) {
    case 'running': return 'running'
    case 'blocked': return 'blocked'
    case 'resolved': case 'idle': return 'done'
    default: return 'paused'
  }
}

/** An attempt's result in words. */
export const ATTEMPT_WORD: Record<AttemptResult, string> = mobileMessages.MobileCore.attempts

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

