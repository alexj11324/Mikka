import type { BlockIssue, BlockRun, TaskBlock } from './task-blocked'
import type { CompactRunFailure } from './run-failure-view'

export type TaskState = 'waiting' | 'blocked' | 'failed' | 'running' | 'queued' | 'todo' | 'done' | 'canceled' | 'duplicate'
export type TaskReason = 'needs_input' | 'approval' | 'pr_review' | 'blocked' | 'quota' | 'offline' | 'blocked_by' | 'flagged' | null
export type TaskGroup = 'pending' | 'running' | 'todo' | 'done'
export type TaskStateView = { state: TaskState; reason: TaskReason; blockedBy: string | null; group: TaskGroup }
export type TaskStateRun = BlockRun & {
  pauseReason?: 'human_control' | 'quota_exhausted' | null
  stopReason?: string | null
  failureDetails?: CompactRunFailure | null
  awaitingApproval?: boolean
  /** The existing web thread projection carries waitingFor only for an offline device. */
  waitingFor?: unknown
  deviceOffline?: boolean
  threadReplacedBy?: string | null
}
export type TaskStateContext = { block?: TaskBlock | null; schedule?: { nextAt: string | null } | null }

export function taskGroupOf(state: TaskState): TaskGroup {
  switch (state) {
    case 'waiting': case 'blocked': case 'failed': return 'pending'
    case 'running': case 'queued': return 'running'
    case 'todo': return 'todo'
    default: return 'done'
  }
}

/** A reason from fixed run facts only; never infer status from provider prose. */
export function attemptBlockReason(run: TaskStateRun): 'blocked' | 'quota' | 'offline' | null {
  if (run.deviceOffline || run.waitingFor || run.stopReason === 'device_lost') return 'offline'
  if (run.pauseReason === 'quota_exhausted' || run.stopReason === 'quota_exhausted' || run.failureDetails?.category === 'quota' || run.failureDetails?.code === 'run_quota_exceeded') return 'quota'
  if (run.status === 'paused' && run.pauseReason !== 'human_control') return 'quota' // historical pauses predate pauseReason
  if (run.outcome === 'blocked' || ['subscription', 'api_key', 'access_denied'].includes(run.failureDetails?.category ?? '')) return 'blocked'
  return null
}

/** One task state for web and mobile. Only the task itself can close the task. */
export function taskStateOf(issue: BlockIssue, run?: TaskStateRun | null, context: TaskStateContext = {}): TaskStateView {
  const view = (state: TaskState, reason: TaskReason = null, blockedBy: string | null = null): TaskStateView => ({ state, reason, blockedBy, group: taskGroupOf(state) })
  if (issue.status === 'done' || issue.status === 'canceled' || issue.status === 'duplicate') return view(issue.status)
  const relation = (state: TaskState) => context.block?.reason === 'dependency'
    ? view(state, 'blocked_by', context.block.blockerIdentifier ?? null)
    : context.block?.reason === 'flagged' ? view(state, 'flagged') : view(state)
  if (run && !run.threadReplacedBy) {
    const blocked = attemptBlockReason(run)
    if (blocked) return view('blocked', blocked)
    if (run.awaitingApproval || (run.status === 'paused' && run.pauseReason === 'human_control')) return view('waiting', 'approval')
    if (run.status === 'waiting_input') return view('waiting', 'needs_input')
    if (['preparing', 'running', 'finishing'].includes(run.status)) return relation('running')
    if (run.status === 'queued') return relation('queued')
    if (run.outcome === 'needs_input') return view('waiting', 'needs_input')
    if (run.outcome === 'failed' || run.status === 'failed') return view('failed')
  }
  if (issue.status === 'review' || issue.metadata.pullRequests.some(pr => pr.state === 'open' || pr.state === 'draft')) return view('waiting', 'pr_review')
  return relation(context.schedule?.nextAt ? 'queued' : 'todo')
}

export type AttemptState = 'running' | 'paused' | 'done' | 'failed' | 'blocked' | 'replaced'
/** Attempts show their own result, independent of the task's PRs or closed status. */
export function attemptStateOf(run: TaskStateRun): AttemptState {
  if (run.threadReplacedBy) return 'replaced'
  if (attemptBlockReason(run)) return 'blocked'
  if (run.awaitingApproval || run.status === 'waiting_input' || (run.status === 'paused' && run.pauseReason === 'human_control')) return 'paused'
  if (['queued', 'preparing', 'running', 'finishing'].includes(run.status)) return 'running'
  if (run.outcome === 'needs_input') return 'paused'
  if (run.status === 'failed' || run.outcome === 'failed') return 'failed'
  return 'done'
}
