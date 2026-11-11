import { threadGroup, type GroupIssue, type ThreadGroup } from './thread-groups'
import { attemptStateOf, taskStateOf, type AttemptState, type TaskGroup, type TaskStateContext, type TaskStateRun } from './task-state'

export type MobileTaskGroup = TaskGroup
export type MobileTaskBot = { id: string; name: string; color: string; shape: string }
export type MobileTaskSchedule = { label: string; nextAt: string | null }

/** Compatibility entry point; all grouping is derived from the shared task state. */
export function mobileTaskGroup(issue: GroupIssue, run?: TaskStateRun | null, context: TaskStateContext = {}): MobileTaskGroup {
  return taskStateOf(issue, run, context).group
}

export type MobileTaskAttempt = TaskStateRun & { harness: string; createdAt: Date; threadReplacedBy: string | null; pullRequest?: { url: string } | null }
export type MobileTaskActivity =
  | { kind: 'attempt'; runId: string; n: number; group: ThreadGroup; state: AttemptState; pullRequest: { number: number; url: string } | null; harness: string; createdAt: string; failed: boolean }
  | { kind: 'replaced'; runId: string; createdAt: string }
  | { kind: 'created'; by: string | null; createdAt: string }

/** Number attempts oldest first, then return a stable newest-first activity feed. */
export function mobileTaskActivity(issue: GroupIssue, runs: readonly MobileTaskAttempt[], created: { by: string | null; createdAt: Date }): MobileTaskActivity[] {
  const ordered = [...runs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.runId.localeCompare(b.runId))
  const byId = new Map(ordered.map(run => [run.runId, run]))
  const activity: MobileTaskActivity[] = [{ kind: 'created', by: created.by, createdAt: created.createdAt.toISOString() }]
  ordered.forEach((run, index) => {
    const group = threadGroup({ id: run.runId, status: run.status, outcome: run.outcome, issueId: null, createdAt: run.createdAt.toISOString() }, issue)
    const number = Number(/\/pull\/(\d+)\/?$/.exec(run.pullRequest?.url ?? '')?.[1])
    const pullRequest = number && run.pullRequest ? { number, url: run.pullRequest.url } : null
    activity.push({ kind: 'attempt', state: attemptStateOf(run), pullRequest, runId: run.runId, n: index + 1, group, harness: run.harness, createdAt: run.createdAt.toISOString(), failed: run.status === 'failed' || run.outcome === 'failed' })
    const replacement = run.threadReplacedBy && byId.get(run.threadReplacedBy)
    if (replacement) activity.push({ kind: 'replaced', runId: replacement.runId, createdAt: replacement.createdAt.toISOString() })
  })
  const rank = { attempt: 0, replaced: 1, created: 2 }
  return activity.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || rank[a.kind] - rank[b.kind] || ('runId' in a && 'runId' in b ? b.runId.localeCompare(a.runId) : 0))
}
