'use client'

import { useMemo } from 'react'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { attemptStateOf, taskStateOf, type TaskGroup, type TaskReason, type TaskState as CanonicalTaskState, type TaskStateRun, type TaskStateView } from '@/lib/task-state'
import { taskBlock, type BlockIssue } from '@/lib/task-blocked'

export type { TaskGroup, TaskReason } from '@/lib/task-state'
/** Released hosted icon dictionaries also render an idle attempt. TaskRow stays canonical. */
export type TaskState = CanonicalTaskState | 'idle'
type Issue = Awaited<ReturnType<typeof listIssues>>[number]
export const TASK_GROUPS: readonly TaskGroup[] = ['pending', 'running', 'todo', 'done']
export type TaskRow = {
  issue: Issue
  /** The task's newest attempt; null for a task the Factory has never run (it is still a task). */
  current: Thread | null
  /** How many attempts the task has had; 0 for one never run. */
  attempts: number
} & TaskStateView

type LegacySlotRun = Omit<TaskStateRun, 'runId' | 'outcome'> & { runId?: string; outcome?: string | null }

/**
 * @deprecated Released hosted runState/attemptOutcome callers use this name for
 * Run cards and attempt history. Keep their signature and idle/queued vocabulary
 * around the shared attempt mapper. Task lists must use tasksOf/taskStateOf:
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

/**
 * Join the web's existing live lists once. No per-task requests.
 *
 * The task is the business entity and a thread is how one of its attempts ran (decision 2026-11-11: 看板 and its list
 * are the task's views, there is no separate 任务 page). So the issues drive the rows: a task the Factory has never run
 * has no thread and is still a task — 待办, or 已完成 once closed. Threads only enrich a row: `current` is that task's
 * newest one, and `attempts` how many it has had. Threads with no task of this list (another workspace's, or none) are
 * not rows. Rows keep the issues' order, so the list's own sort shows through.
 */
export function tasksOf(threads: readonly Thread[], issues: readonly Issue[]): Record<TaskGroup, TaskRow[]> {
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const newest = new Map<string, Thread>()
  const attempts = new Map<string, number>()
  for (const thread of threads) {
    if (!thread.issueId || !byId.has(thread.issueId)) continue
    attempts.set(thread.issueId, (attempts.get(thread.issueId) ?? 0) + 1)
    const current = newest.get(thread.issueId)
    if (!current || thread.createdAt > current.createdAt || (thread.createdAt === current.createdAt && thread.id > current.id)) newest.set(thread.issueId, thread)
  }
  const groups: Record<TaskGroup, TaskRow[]> = { pending: [], running: [], todo: [], done: [] }
  const isOpen = (id: string) => {
    const blocker = byId.get(id)
    return Boolean(blocker && !['done', 'canceled', 'duplicate'].includes(blocker.status))
  }
  for (const issue of issues) {
    const thread = newest.get(issue.id)
    const run = thread ? { ...thread, runId: thread.id } : undefined
    const block = taskBlock(issue, run, isOpen)
    if (block?.blockerId) block.blockerIdentifier = byId.get(block.blockerId)?.identifier ?? null
    const state = taskStateOf(issue, run, { block })
    groups[state.group].push({ issue, current: thread ?? null, attempts: attempts.get(issue.id) ?? 0, ...state })
  }
  return groups
}

export function useTasksOf(threads: readonly Thread[], issues: readonly Issue[]) {
  return useMemo(() => tasksOf(threads, issues), [threads, issues])
}

/** Only tasks asking for a reply, approval or PR review raise the window bar's hand. */
export function pendingTaskCount(threads: readonly Thread[], issues: readonly Issue[]) {
  return tasksOf(threads, issues).pending.filter(row => row.state === 'waiting').length
}

/** A pending Factory question as 收件箱 needs it: the task it waits on, when it has one (hooks/use-factory-questions.ts). */
export type InboxQuestion = { issueId: string | null }

/**
 * What 收件箱 lists, from the workspace's own lists: every pending Factory question, then every task waiting on the
 * person (等你处理, not 受阻 or 失败) that no question already stands for (a task waiting on a question is listed once,
 * as the question). The suggestions follow them. The rail's count on 收件箱 is `inboxCount`, read from this same
 * selection, so the count and the list never disagree.
 */
export function inboxSelection<Q extends InboxQuestion>(threads: readonly Thread[], issues: readonly Issue[], questions: readonly Q[]): { questions: readonly Q[]; tasks: TaskRow[] } {
  const asked = new Set(questions.flatMap(question => question.issueId ? [question.issueId] : []))
  return { questions, tasks: tasksOf(threads, issues).pending.filter(row => row.state === 'waiting' && !asked.has(row.issue.id)) }
}

/** How many items 收件箱 lists: its questions, its waiting tasks and its suggestions (`inboxSelection`). */
export function inboxCount(threads: readonly Thread[], issues: readonly Issue[], questions: readonly InboxQuestion[], suggestions: number) {
  const { questions: asked, tasks } = inboxSelection(threads, issues, questions)
  return asked.length + tasks.length + suggestions
}
