'use client'

// A task has one status, its status field, drawn with the same icon on every surface (decision 2026-11-13-1405):
// TaskStatusIcon. What its Agent is doing is TaskRunMark, a small mark beside the status (working, waiting for the
// person, error); it is never a status, a group or a column. TaskStatusMark draws the two together.
import { useTranslations } from 'next-intl'
import { Hand, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react'
import { cn } from 'cn'
import { ISSUE_STATUSES } from '@/components/workspace/issue-properties'
import { runIndicatorOf, type RunIndicator, type TaskState } from '@/lib/task-state'
import { statusIconTints, type StatusTone } from '@/lib/status-appearance'

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

const RUN_MARKS: Record<RunIndicator, { icon: LucideIcon; tone: StatusTone }> = {
  working: { icon: LoaderCircle, tone: 'warning' },
  waiting: { icon: Hand, tone: 'info' },
  error: { icon: TriangleAlert, tone: 'destructive' },
}

/** The words of a run mark, for its tooltip and for assistive technology. They are not status names. */
export function useRunIndicatorLabel() {
  const t = useTranslations('Issue.agentMark')
  return (indicator: RunIndicator) => t(indicator)
}

/** What the task's Agent is doing, as a small mark; nothing when no run is under way, waiting or failed. */
export function TaskRunMark({ state, indicator = state ? runIndicatorOf(state) : null, plain = false }: { state?: TaskState | 'idle' | null; indicator?: RunIndicator | null; /** The shape alone, in the colour of where it sits (a paid block's slot). */ plain?: boolean }) {
  const label = useRunIndicatorLabel()
  if (!indicator) return null
  const mark = RUN_MARKS[indicator]
  return <span role="img" aria-label={label(indicator)} title={label(indicator)} data-run-indicator={indicator} className="inline-flex shrink-0">
    <mark.icon aria-hidden="true" className={cn('size-3', !plain && statusIconTints[mark.tone], indicator === 'working' && 'motion-safe:animate-spin [animation-duration:1.6s]')} />
  </span>
}

/** A task's status icon with its Agent's mark after it. */
export function TaskStatusMark({ status, state, size }: { status: string; state?: TaskState | 'idle' | null; size?: TaskIconSize }) {
  return <span className="inline-flex shrink-0 items-center gap-0.5"><TaskStatusIcon status={status} size={size} /><TaskRunMark state={state} /></span>
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
