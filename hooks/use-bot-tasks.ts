'use client'

import { useMemo } from 'react'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { mobileTaskGroup, type MobileTaskGroup as TaskGroup } from '@/lib/mobile-task-view'
import { threadIsActive, type GroupIssue } from '@/lib/thread-groups'

export type { TaskGroup }

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/** 等待你 · 进行中 · 待办 · 已完成, in this order everywhere (decisions 2026-11-07-2045 and 2230). */
export const TASK_GROUPS: readonly TaskGroup[] = ['pending', 'running', 'todo', 'done']

/** A row in a task list: the task, its current thread (the newest), and how many threads it has had. */
export type TaskRow = { issue: Issue; current: Thread; attempts: number; group: TaskGroup; state: TaskState; reason: TaskReason | null }

/**
 * One state per task, one icon per state (decision 2026-11-07-2230, with 受阻 split out on #1681): 等你处理 (the only
 * hand: 等你回复, 等你确认, 待审阅), 受阻 (login, key, permission, quota, device) and 失败 in 等待你;
 * 运行中 and 排队中 in 进行中; the board's open and closed statuses in 待办 and 已完成.
 */
export type TaskState = 'waiting' | 'blocked' | 'failed' | 'running' | 'queued' | 'todo' | 'idle' | 'done' | 'canceled' | 'duplicate'
/** Why a task waits for the person, or what blocks it, in its grey line. */
export type TaskReason = 'needsReply' | 'confirm' | 'review' | 'quota'

type RunState = { status: string; outcome?: string | null }

/**
 * A task's state and reason from its board status and current attempt, in threadGroup's order (R-52). A local
 * derivation until the shared taskStateOf() lands (coordinator, #1681); it agrees with mobileTaskGroup's groups.
 */
export function localTaskState(issue: GroupIssue, run?: RunState | null): { state: TaskState; reason: TaskReason | null } {
  if (issue.status === 'canceled' || issue.status === 'duplicate') return { state: issue.status, reason: null }
  if (issue.status === 'done') return { state: 'done', reason: null }
  if (!run) return { state: issue.status === 'backlog' ? 'idle' : 'todo', reason: null }
  if (threadIsActive(run)) return { state: run.status === 'queued' ? 'queued' : 'running', reason: null }
  if (run.status === 'waiting_input') return { state: 'waiting', reason: 'needsReply' }
  if (run.status === 'paused') return { state: 'blocked', reason: 'quota' }
  if (issue.metadata.pullRequests.some(pr => pr.state === 'merged')) return { state: 'done', reason: null }
  if (run.outcome === 'failed') return { state: 'failed', reason: null }
  if (run.outcome === 'blocked') return { state: 'blocked', reason: null }
  if (issue.status === 'review' || issue.metadata.pullRequests.some(pr => pr.state === 'open' || pr.state === 'draft')) return { state: 'waiting', reason: 'review' }
  if (run.outcome === 'done') return { state: 'done', reason: null }
  if (run.outcome === 'idle') return { state: 'idle', reason: null }
  if (run.outcome === 'needs_input') return { state: 'waiting', reason: 'needsReply' }
  if (run.status === 'failed') return { state: 'failed', reason: null }
  return { state: 'waiting', reason: 'confirm' }
}

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
    groups[group].push({ issue, current: thread, attempts: attempts.get(thread.issueId)!, group, ...localTaskState(issue, thread) })
  }
  return groups
}

/** The tasks a bot dispatched (its threads' tasks), grouped; `threads` are already that bot's. */
export function useTasksOf(threads: readonly Thread[], issues: readonly Issue[]) {
  return useMemo(() => tasksOf(threads, issues), [threads, issues])
}

/** How many tasks wait for the person (等你处理: the hand, not 受阻 or 失败), for 全部任务's count (decision 2026-11-07-2230). */
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
