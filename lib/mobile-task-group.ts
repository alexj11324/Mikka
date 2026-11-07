import { threadGroup, type GroupIssue, type ThreadGroup } from '@/lib/thread-groups'

/** A task list's group (decisions/2026-11-07-2045-tasks-only-threads-inside.md): 待处理 · 进行中 · 待办 · 已完成. */
export type TaskGroup = 'pending' | 'running' | 'todo' | 'done'

const CLOSED = new Set(['done', 'canceled', 'duplicate'])

/** R-52's thread groups as task groups: 等待你 and 受阻 are 待处理, 空闲 is 待办, 已解决 is 已完成. */
export const TASK_GROUP_OF: Record<ThreadGroup, TaskGroup> = { waiting: 'pending', blocked: 'pending', running: 'running', idle: 'todo', resolved: 'done' }

/**
 * Which group a task is in: closed is 已完成; 受阻 on the board (a question, a quota, a dependency) is 待处理; else
 * its current thread decides by R-52's judgement, and a task with no thread is 待办.
 */
export function taskGroup(issue: GroupIssue, run: { id: string; status: string; outcome?: string | null; createdAt?: Date | string } | undefined, blocked: boolean): TaskGroup {
  if (CLOSED.has(issue.status)) return 'done'
  if (blocked) return 'pending'
  if (!run) return 'todo'
  const createdAt = run.createdAt instanceof Date ? run.createdAt.toISOString() : run.createdAt ?? ''
  return TASK_GROUP_OF[threadGroup({ id: run.id, status: run.status, issueId: null, createdAt, outcome: (run.outcome ?? null) as never }, issue)]
}

/** One of a task's threads, as 活动 lists it. */
export type ActivityRun = { runId: string; harness: string; createdAt: Date; replacedBy: string | null; group: ThreadGroup; failed: boolean }

export type TaskActivity =
  | { kind: 'attempt'; runId: string; n: number; group: ThreadGroup; harness: string; createdAt: string; failed: boolean }
  | { kind: 'replaced'; runId: string; createdAt: string }
  | { kind: 'created'; by: string | null; createdAt: string }

/**
 * 活动, newest first: each thread is an attempt numbered from the first (第 N 次尝试); a thread the person replaced
 * with a new one adds 换了新线程 when the new one starts; the task's creation is last. `runs` come oldest first.
 */
export function taskActivity(runs: readonly ActivityRun[], createdAt: Date): TaskActivity[] {
  const started = new Map(runs.map(run => [run.runId, run.createdAt]))
  const items: { at: Date; order: number; item: TaskActivity }[] = [{ at: createdAt, order: -1, item: { kind: 'created', by: null, createdAt: createdAt.toISOString() } }]
  runs.forEach((run, index) => {
    items.push({ at: run.createdAt, order: index * 2 + 1, item: { kind: 'attempt', runId: run.runId, n: index + 1, group: run.group, harness: run.harness, createdAt: run.createdAt.toISOString(), failed: run.failed } })
    const next = run.replacedBy ? started.get(run.replacedBy) : undefined
    if (run.replacedBy && next) items.push({ at: next, order: runs.findIndex(other => other.runId === run.replacedBy) * 2, item: { kind: 'replaced', runId: run.replacedBy, createdAt: next.toISOString() } })
  })
  return items.sort((a, b) => b.at.getTime() - a.at.getTime() || b.order - a.order).map(entry => entry.item)
}
