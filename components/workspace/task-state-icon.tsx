'use client'

// A task has one status, its status field, drawn with the same icon on every surface (decision 2026-11-13-1405):
// TaskStatusIcon, and a task's chip carries that one icon only. What an Agent is doing belongs to the conversation:
// TaskRunMark is its small mark (working, waiting for the person, error; EXECUTION_VISUALS), drawn on the conversation's own surfaces and
// never beside a status icon. TaskStatusMark is a conversation card's one glyph: the mark while active, else the status.
import { useCallback } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Circle, CircleCheck, CircleDashed, CirclePause, CircleSlash2, CircleX, Clock, Hand, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ISSUE_STATUSES } from '@/components/workspace/issue-properties'
import { runIndicatorOf, type RunIndicator, type TaskState } from '@/lib/task-state'
import { statusIconTints, type StatusTone } from '@/lib/status-appearance'
import { RunningIcon } from '@/components/workspace/status-icons'

const STATUS_ICONS = new Map<string, LucideIcon>(ISSUE_STATUSES.map(status => [status.value, status.icon]))
// R-34's colours, as ISSUE_STATUSES' indicatorClassName names them: 进行中 amber, 评审中 blue, 已完成 green, the rest grey.
const STATUS_TONES: Record<string, StatusTone> = { doing: 'warning', review: 'info', done: 'success' }
export type TaskIconSize = 'sm' | 'md' | 'lg'

/**
 * A task's status icon: the status field's, in its colour. An unknown status draws the first one's shape, grey.
 * `plain` draws the shape alone, in the colour of where it sits: for a paid block's own status slot, which keeps its
 * colour tokens (decision 2026-11-13-1405, the status-icon exception).
 */
export function TaskStatusIcon({ status, size = 'sm', plain = false }: { status: string; size?: TaskIconSize; plain?: boolean }) {
  const Icon = STATUS_ICONS.get(status) ?? ISSUE_STATUSES[0].icon
  return <Icon aria-hidden="true" data-task-status={status} className={cn('shrink-0', size === 'lg' ? 'size-[18px]' : size === 'md' ? 'size-4' : 'size-3.5', !plain && statusIconTints[STATUS_TONES[status] ?? 'neutral'])} />
}

/**
 * Every run state's glyph and colour, in one table read by every surface (decision 2026-11-18-0300, after LobeHub's
 * ExecutionStatus: one semantic, one visual). All lucide, in the status icons' circle family: the Agent mark, a run's
 * own result (a run with no task, an attempt) and the board's 受阻 read it. A task's status is TaskStatusIcon.
 */
export const EXECUTION_VISUALS = {
  running: { icon: RunningIcon, tone: 'warning' },
  queued: { icon: Clock, tone: 'warning' },
  waiting: { icon: Hand, tone: 'info' },
  // A run that ended waiting on the person; the hand stays on the task (decision 2026-11-07-2300).
  paused: { icon: CirclePause, tone: 'info' },
  blocked: { icon: OctagonAlert, tone: 'warning' },
  failed: { icon: TriangleAlert, tone: 'destructive' },
  done: { icon: CircleCheck, tone: 'success' },
  canceled: { icon: CircleX, tone: 'neutral' },
  duplicate: { icon: CircleSlash2, tone: 'neutral' },
  todo: { icon: Circle, tone: 'neutral' },
  idle: { icon: CircleDashed, tone: 'neutral' },
} as const satisfies Record<string, { icon: LucideIcon; tone: StatusTone }>
export type ExecutionState = keyof typeof EXECUTION_VISUALS

/**
 * A run state's glyph, in its colour. `plain` draws the shape alone, in the colour of where it sits (a paid block's
 * slot); `fill` takes the size of the box it is in.
 */
export function ExecutionIcon({ state, size = 'sm', plain = false }: { state: ExecutionState; size?: TaskIconSize | 'xs' | 'fill'; plain?: boolean }) {
  const visual = EXECUTION_VISUALS[state]
  return <visual.icon aria-hidden="true" data-execution-state={state} className={cn('shrink-0', size === 'fill' ? 'size-full' : size === 'lg' ? 'size-[18px]' : size === 'md' ? 'size-4' : size === 'xs' ? 'size-3' : 'size-3.5', !plain && statusIconTints[visual.tone])} />
}

const RUN_MARKS: Record<RunIndicator, ExecutionState> = { working: 'running', waiting: 'waiting', error: 'failed' }

/** The words of a run mark, for its tooltip and for assistive technology. They are not status names. */
export function useRunIndicatorLabel() {
  const t = useTranslations('Issue.agentMark')
  return useCallback((indicator: RunIndicator) => t(indicator), [t])
}

/** What the task's Agent is doing, as a small mark; nothing when no run is under way, waiting or failed. */
export function TaskRunMark({ state, indicator = state ? runIndicatorOf(state) : null, plain = false }: { state?: TaskState | 'idle' | null; indicator?: RunIndicator | null; /** The shape alone, in the colour of where it sits (a paid block's slot). */ plain?: boolean }) {
  const label = useRunIndicatorLabel()
  if (!indicator) return null
  return <span role="img" aria-label={label(indicator)} title={label(indicator)} data-run-indicator={indicator} className="inline-flex shrink-0">
    <ExecutionIcon state={RUN_MARKS[indicator]} plain={plain} size="xs" />
  </span>
}

/**
 * The one glyph of a conversation's card (a dispatch card): what the conversation is doing while it is working, waiting
 * or failed, otherwise its task's status icon. Never both: two status-like glyphs are never side by side.
 */
export function TaskStatusMark({ status, indicator, size }: { status: string; indicator?: RunIndicator | null; size?: TaskIconSize }) {
  return indicator ? <TaskRunMark indicator={indicator} /> : <TaskStatusIcon status={status} size={size} />
}

/** A status's name, as the board's column and the status menu write it. */
export function useTaskStatusLabel() {
  const t = useTranslations('Issue.status')
  return (status: string) => t.has(status as never) ? t(status as never) : status
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
