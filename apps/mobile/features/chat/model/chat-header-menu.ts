import type { Task, TaskState } from '@/lib/types'
import { groupOf, rowState, TASK_GROUPS } from '@/features/tasks/model/task-groups'

/** How many of the bot's tasks the title menu lists before 「全部任务」. */
export const MENU_TASKS = 5

/** The SF Symbol for a task's own state (2026-11-07-2230): the hand only for 等你处理; else the board's status icon. */
const STATE_SYMBOL: Record<TaskState, string> = { waiting: 'hand.raised', failed: 'exclamationmark.triangle', blocked: 'exclamationmark.octagon', running: 'circle.dotted', queued: 'clock' }
const BOARD_SYMBOL: Record<string, string> = { backlog: 'circle.dashed', todo: 'circle', doing: 'circle.dotted', review: 'gauge.with.dots.needle.33percent', done: 'checkmark.circle', canceled: 'xmark.circle', duplicate: 'circle.slash' }

export function taskSymbol(task: Pick<Task, 'group' | 'status' | 'blocked' | 'state' | 'reason'>) {
  const { state } = rowState(task)
  return (state ? STATE_SYMBOL[state] : BOARD_SYMBOL[task.status] ?? 'circle') as 'circle'
}

/**
 * The tasks the chat title's menu lists (2026-11-07: lists show tasks only): the tasks this bot dispatched, 等待你
 * first, then 进行中 and 待办, a few of them; 已完成 only when nothing else is left.
 */
export function menuTasks(tasks: readonly Task[] | null | undefined, botId: string | null | undefined, limit = MENU_TASKS): Task[] {
  const own = (tasks ?? []).filter(task => botId && (task.dispatchedBy === botId || task.bot?.id === botId))
  const rank = (task: Task) => TASK_GROUPS.findIndex(group => group.id === groupOf(task))
  const open = own.filter(task => groupOf(task) !== 'done').sort((a, b) => rank(a) - rank(b))
  return (open.length ? open : own).slice(0, limit)
}
