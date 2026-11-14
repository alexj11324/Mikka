'use client'

// A task's one state as an icon (decision 2026-11-07-2230, 受阻 split out on #1681), drawn as the official build's
// task rows draw it (mikka-hosted-ui components/mikka/task-state.tsx): the hand is 等你处理, an octagon 受阻, a
// triangle 失败, the ring 运行中, a clock 排队中, a circle 待办, a dashed circle 暂不处理, a check 完成, ✕ 已取消.
// The state comes from localTaskState; this file only draws it. Colour follows what the state asks of the person.
import type { ComponentType } from 'react'
import { useTranslations } from 'next-intl'
import { Ban, Circle, CircleCheck, CircleDashed, CircleDot, CircleX, Clock, Hand, OctagonAlert, TriangleAlert, type LucideIcon, type LucideProps } from 'lucide-react'
import { ISSUE_STATUSES } from '@/components/workspace/issue-properties'
import { cn } from 'cn'
import type { TaskReason, TaskState } from '@/hooks/use-bot-tasks'
import { statusIconTints, type StatusTone } from '@/lib/status-appearance'

const STATE_ICONS: Record<TaskState, ComponentType<LucideProps>> = {
  waiting: Hand, blocked: OctagonAlert, failed: TriangleAlert, running: CircleDot, queued: Clock, todo: Circle, idle: CircleDashed,
  done: CircleCheck, canceled: CircleX, duplicate: Ban,
}

// Blue waits on you, amber is under way or held, red failed, green done, greys are not active (as the official rows).
const STATE_TONES: Record<TaskState, StatusTone> = {
  waiting: 'info', blocked: 'warning', failed: 'destructive', running: 'warning', queued: 'warning', todo: 'neutral', idle: 'neutral',
  done: 'success', canceled: 'neutral', duplicate: 'neutral',
}

/** A task's own state icon; never a run's result or its thread group. */
export function TaskStateIcon({ state }: { state: TaskState }) {
  const Icon = STATE_ICONS[state]
  return <Icon aria-hidden="true" data-task-state={state} className={cn('size-3.5 shrink-0', statusIconTints[STATE_TONES[state]])} />
}

/** A task state's words, as its rows lead with them: the reason it waits when there is one, else the state's name. */
export function useTaskStateLabel() {
  const t = useTranslations('Shell.panel')
  return (state: TaskState, reason: TaskReason | null) => reason ? t(`task.reason.${reason}`) : state === 'waiting' ? t('taskGroup.pending') : t(`task.state.${state}`)
}

type ThreadRun = { id: string; status: string; outcome?: string | null; createdAt: Date | string; continuation?: { status: string; outcome?: string | null } | null }

/**
 * The run that decides a task's state: its newest thread's live run (the chain's newest attempt, else the thread's
 * own run), as the task rows and the work area read it. Null for a task no thread has worked on.
 */
export function newestThreadRun(threads: readonly ThreadRun[] | undefined): { status: string; outcome: string | null } | null {
  const time = (thread: ThreadRun) => new Date(thread.createdAt).getTime()
  const newest = (threads ?? []).reduce<ThreadRun | null>((best, thread) => !best || time(thread) > time(best) || (time(thread) === time(best) && thread.id > best.id) ? thread : best, null)
  if (!newest) return null
  const live = newest.continuation ?? newest
  return { status: live.status, outcome: live.outcome ?? null }
}

const STATUS_SIZE = { sm: 'size-3.5', md: 'size-4', lg: 'size-5' } as const

/** The board status glyph the official layer still draws (one status, one icon). */
export function TaskStatusIcon({ status, size = 'md', plain = false }: { status: string; size?: keyof typeof STATUS_SIZE; plain?: boolean }) {
  const option = ISSUE_STATUSES.find(item => item.value === status)
  const Icon: LucideIcon = option?.icon ?? Circle
  return <Icon aria-hidden="true" data-task-status={status} className={cn(STATUS_SIZE[size], 'shrink-0', plain ? undefined : option?.indicatorClassName)} />
}

/** A run's activity mark. The official rows use it when a task has no board status of its own. */
export function TaskRunMark({ indicator, plain = false }: { indicator: string; plain?: boolean }) {
  const state = indicator in STATE_ICONS ? indicator as TaskState : 'running'
  const Icon = STATE_ICONS[state]
  return <Icon aria-hidden="true" data-run-indicator={indicator} className={cn('size-3.5 shrink-0', plain ? undefined : statusIconTints[STATE_TONES[state]])} />
}

/** Status when the task has one, otherwise what the run is doing. */
export function TaskStatusMark({ status, indicator, size = 'md' }: { status: string; indicator?: string | null; size?: keyof typeof STATUS_SIZE }) {
  if (indicator) return <TaskRunMark indicator={indicator} />
  return <TaskStatusIcon status={status} size={size} />
}

/** The status word on a board column, list section and task row. */
export function useTaskStatusLabel() {
  const t = useTranslations('Issue')
  return (status: string) => t.has(`status.${status}` as 'status.todo') ? t(`status.${status}` as 'status.todo') : status
}

/** Words for what an Agent is doing, beside the task's own status. */
export function useRunIndicatorLabel() {
  const label = useTaskStateLabel()
  return (indicator: string) => indicator in STATE_ICONS ? label(indicator as TaskState, null) : indicator
}
