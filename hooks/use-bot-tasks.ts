'use client'

import { useMemo } from 'react'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { mobileTaskGroup, type MobileTaskGroup as TaskGroup } from '@/lib/mobile-task-view'

export type { TaskGroup }

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/** 待处理 · 进行中 · 待办 · 已完成, in this order everywhere (decision 2026-11-07-2045). */
export const TASK_GROUPS: readonly TaskGroup[] = ['pending', 'running', 'todo', 'done']

/** A row in a task list: the task, its current thread (the newest), and how many threads it has had. */
export type TaskRow = { issue: Issue; current: Thread; attempts: number; group: TaskGroup }

/**
 * Lists show tasks; a thread is reached from inside its task (decision
 * 2026-11-07-2045). The tasks behind `threads`, each in its group by its
 * current thread's state (R-52, through `mobileTaskGroup`, the mapping the
 * phone's task API uses). It reads the thread and task lists the workspace already keeps live:
 * no read per task. A thread with no task, or whose task is not in the list
 * (older than the list reads), has no row.
 */
export function tasksOf(threads: readonly Thread[], issues: readonly Issue[]): Record<TaskGroup, TaskRow[]> {
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const newest = new Map<string, Thread>()
  const attempts = new Map<string, number>()
  for (const thread of threads) {
    if (!thread.issueId || !byId.has(thread.issueId)) continue
    attempts.set(thread.issueId, (attempts.get(thread.issueId) ?? 0) + 1)
    const current = newest.get(thread.issueId)
    if (!current || thread.createdAt > current.createdAt) newest.set(thread.issueId, thread)
  }
  const groups: Record<TaskGroup, TaskRow[]> = { pending: [], running: [], todo: [], done: [] }
  // In the order the threads came (newest activity first), one row per task.
  for (const thread of threads) {
    if (!thread.issueId || newest.get(thread.issueId) !== thread) continue
    const issue = byId.get(thread.issueId)!
    // The one task mapping (#1673): threadGroup() collapsed to four groups, a closed task always 已完成.
    const group = mobileTaskGroup(issue, { runId: thread.id, status: thread.status, outcome: thread.outcome ?? null })
    groups[group].push({ issue, current: thread, attempts: attempts.get(thread.issueId)!, group })
  }
  return groups
}

/** The tasks a bot dispatched (its threads' tasks), grouped; `threads` are already that bot's. */
export function useTasksOf(threads: readonly Thread[], issues: readonly Issue[]) {
  return useMemo(() => tasksOf(threads, issues), [threads, issues])
}

/** How many tasks wait on the person (待处理), for 全部任务's count. */
export function pendingTaskCount(threads: readonly Thread[], issues: readonly Issue[]) {
  return tasksOf(threads, issues).pending.length
}
