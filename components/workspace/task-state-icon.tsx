'use client'

// A task has one status, its status field, drawn with the same mark on every surface (decision 2026-11-13-1405):
// TaskStatusIcon, and a task's chip carries that one icon only. What an Agent is doing belongs to the conversation:
// TaskRunMark is its small mark (working, waiting for the person, error; EXECUTION_VISUALS), drawn on the conversation's own surfaces and
// never beside a status icon. TaskStatusMark is a conversation card's one glyph: the mark while active, else the status.
// Both marks come from the one registry (`lib/state-mark.ts`), so no shape or colour is chosen here.
import { useCallback } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { runIndicatorOf, type RunIndicator, type TaskState } from '@/lib/task-state'
import { Mark } from '@/components/workspace/state-mark'
import { runMarkOf, statusMarkOf, type MarkSize } from '@/lib/state-mark'

/** The mark ladder, under the name this module's call sites already use. */
export type TaskIconSize = MarkSize

/**
 * A task's status icon: the status field's mark (R-34's colour and shape). An unknown status draws 待整理's. `plain`
 * draws the shape alone, in the colour of where it sits: for a paid block's own status slot, which keeps its colour
 * tokens (decision 2026-11-13-1405, the status-icon exception).
 */
export function TaskStatusIcon({ status, size = 'sm', plain = false }: { status: string; size?: TaskIconSize; plain?: boolean }) {
  const mark = statusMarkOf(status)
  return <Mark shape={mark.shape} tone={plain ? undefined : mark.tone} size={size} data-task-status={status} />
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
  const mark = runMarkOf(indicator)
  return <span role="img" aria-label={label(indicator)} title={label(indicator)} data-run-indicator={indicator} className="inline-flex shrink-0">
    <Mark shape={mark.shape} tone={plain ? undefined : mark.tone} spin={indicator === 'working'} />
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
