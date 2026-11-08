'use client'

import { useMemo } from 'react'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { taskStateOf, type TaskGroup, type TaskStateView } from '@/lib/task-state'
import { taskBlock } from '@/lib/task-blocked'

export type { TaskGroup, TaskState, TaskReason } from '@/lib/task-state'
type Issue = Awaited<ReturnType<typeof listIssues>>[number]
export const TASK_GROUPS: readonly TaskGroup[] = ['pending', 'running', 'todo', 'done']
export type TaskRow = { issue: Issue; current: Thread; attempts: number } & TaskStateView

/** Join the web's existing live lists once. No per-task requests. */
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
  for (const thread of threads) {
    if (!thread.issueId || newest.get(thread.issueId) !== thread) continue
    const issue = byId.get(thread.issueId)!
    const run = { ...thread, runId: thread.id }
    const block = taskBlock(issue, run, id => {
      const blocker = byId.get(id)
      return Boolean(blocker && !['done', 'canceled', 'duplicate'].includes(blocker.status))
    })
    if (block?.blockerId) block.blockerIdentifier = byId.get(block.blockerId)?.identifier ?? null
    const state = taskStateOf(issue, run, { block })
    groups[state.group].push({ issue, current: thread, attempts: attempts.get(thread.issueId)!, ...state })
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
