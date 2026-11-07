import { threadGroup, type GroupIssue } from './thread-groups'
import type { BlockRun } from './task-blocked'

export type MobileTaskGroup = 'pending' | 'running' | 'todo' | 'done'
export type MobileTaskBot = { id: string; name: string; color: string; shape: string }
export type MobileTaskSchedule = { label: string; nextAt: string | null }

/** Collapse the web's R-52 groups; all decisions about a thread stay in threadGroup. */
export function mobileTaskGroup(issue: GroupIssue, run?: BlockRun | null): MobileTaskGroup {
  if (['done', 'canceled', 'duplicate'].includes(issue.status)) return 'done'
  if (!run) return 'todo'
  const group = threadGroup({ id: run.runId, status: run.status, outcome: run.outcome, issueId: null, createdAt: '' }, issue)
  return ({ waiting: 'pending', blocked: 'pending', running: 'running', idle: 'todo', resolved: 'done' } as const)[group]
}

export type MobileTaskAttempt = BlockRun & { harness: string; createdAt: Date; threadReplacedBy: string | null }
export type MobileTaskActivity =
  | { kind: 'attempt'; runId: string; n: number; group: MobileTaskGroup; harness: string; createdAt: string; failed: boolean }
  | { kind: 'replaced'; runId: string; createdAt: string }
  | { kind: 'created'; by: string | null; createdAt: string }

/** Number attempts oldest first, then return a stable newest-first activity feed. */
export function mobileTaskActivity(issue: GroupIssue, runs: readonly MobileTaskAttempt[], created: { by: string | null; createdAt: Date }): MobileTaskActivity[] {
  const ordered = [...runs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.runId.localeCompare(b.runId))
  const byId = new Map(ordered.map(run => [run.runId, run]))
  const activity: MobileTaskActivity[] = [{ kind: 'created', by: created.by, createdAt: created.createdAt.toISOString() }]
  ordered.forEach((run, index) => {
    activity.push({ kind: 'attempt', runId: run.runId, n: index + 1, group: mobileTaskGroup(issue, run), harness: run.harness, createdAt: run.createdAt.toISOString(), failed: run.status === 'failed' || run.outcome === 'failed' })
    const replacement = run.threadReplacedBy && byId.get(run.threadReplacedBy)
    if (replacement) activity.push({ kind: 'replaced', runId: replacement.runId, createdAt: replacement.createdAt.toISOString() })
  })
  const rank = { attempt: 0, replaced: 1, created: 2 }
  return activity.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || rank[a.kind] - rank[b.kind] || ('runId' in a && 'runId' in b ? b.runId.localeCompare(a.runId) : 0))
}
