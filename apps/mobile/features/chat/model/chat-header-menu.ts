import type { Task, TaskGroup } from '@/lib/types'
import { groupOf, TASK_GROUPS } from '@/features/tasks/model/task-groups'

/** How many of the bot's tasks the title menu lists before 「全部任务」. */
export const MENU_TASKS = 5

/** An SF Symbol for each task group, as the 任务 list draws it (2026-11-07). */
export const TASK_SYMBOL: Record<TaskGroup, 'hand.raised' | 'clock' | 'circle.dashed' | 'checkmark.circle'> = {
  pending: 'hand.raised',
  running: 'clock',
  todo: 'circle.dashed',
  done: 'checkmark.circle',
}

/**
 * The tasks the chat title's menu lists (2026-11-07: lists show tasks only): the tasks this bot dispatched, 待处理
 * first, then 进行中 and 待办, a few of them; 已完成 only when nothing else is left.
 */
export function menuTasks(tasks: readonly Task[] | null | undefined, botId: string | null | undefined, limit = MENU_TASKS): Task[] {
  const own = (tasks ?? []).filter(task => botId && task.bot?.id === botId)
  const rank = (task: Task) => TASK_GROUPS.findIndex(group => group.id === groupOf(task))
  const open = own.filter(task => groupOf(task) !== 'done').sort((a, b) => rank(a) - rank(b))
  return (open.length ? open : own).slice(0, limit)
}
