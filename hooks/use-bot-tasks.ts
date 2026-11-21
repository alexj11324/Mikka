'use client'

import { attemptStateOf, taskStateOf, type TaskGroup, type TaskReason, type TaskState as CanonicalTaskState, type TaskStateRun } from '@/lib/task-state'
import type { BlockIssue } from '@/lib/task-blocked'

export type { TaskGroup, TaskReason } from '@/lib/task-state'
/** Released hosted icon dictionaries also render an idle attempt. Task collection rows stay canonical. */
export type TaskState = CanonicalTaskState | 'idle'
export const TASK_GROUPS: readonly TaskGroup[] = ['pending', 'running', 'todo', 'done']

type LegacySlotRun = Omit<TaskStateRun, 'runId' | 'outcome'> & { runId?: string; outcome?: string | null }

/**
 * @deprecated Released hosted runState/attemptOutcome callers use this name for
 * Run cards and attempt history. Keep their signature and idle/queued vocabulary
 * around the shared attempt mapper. Task lists use authorized Task presentations:
 * a completed attempt never closes its business Task.
 */
export function localTaskState(issue: BlockIssue, run?: LegacySlotRun | null): { state: TaskState; reason: TaskReason } {
  if (!run) {
    const view = taskStateOf(issue)
    return { state: view.state === 'todo' && issue.status === 'backlog' ? 'idle' : view.state, reason: view.reason }
  }
  const outcome = run.outcome === 'done' || run.outcome === 'blocked' || run.outcome === 'needs_input' || run.outcome === 'failed' || run.outcome === 'idle' ? run.outcome : null
  const facts: TaskStateRun = { ...run, runId: run.runId ?? '', outcome }
  const attempt = attemptStateOf(facts)
  // The attempt has no business Task status, PR or dependency context. Reuse the
  // canonical reason classification without letting those Task facts replace it.
  const { reason } = taskStateOf({ status: 'doing', metadata: { pullRequests: [] } }, facts)
  const state: TaskState = attempt === 'paused' ? 'waiting'
    : attempt === 'replaced' || (attempt === 'done' && outcome === 'idle') ? 'idle'
      : attempt === 'running' && run.status === 'queued' ? 'queued' : attempt
  return { state, reason }
}
