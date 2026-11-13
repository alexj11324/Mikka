import type { BlockIssue, BlockRun, TaskBlock } from './task-blocked'
import type { CompactRunFailure } from './run-failure-view'
import type { FactoryFlowView } from './factory/public-flow'

export const TASK_REVIEW_STATUS = 'review'
export const OPEN_TASK_PR_STATES = ['open', 'draft'] as const

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
export type TaskStateContext = {
  block?: TaskBlock | null
  schedule?: { nextAt: string | null } | null
  /** The caller supplies only the currently authorized Factory projection. */
  factory?: Pick<FactoryFlowView, 'stage' | 'needsYou' | 'completion'> | null
}

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
  // Current Factory attention already includes question, candidate and receipt
  // precedence. An old Run's quota/failure must not replace that human handoff.
  const factory = context.factory
  if (factory && factory.stage !== 'completed' && factory.stage !== 'cancelled') {
    switch (factory.needsYou?.kind) {
      case 'question': return view('waiting', 'needs_input')
      case 'spec_review': return view('waiting', 'approval')
      case 'pr_review': return view('waiting', 'pr_review')
      case 'blocked': return view('blocked', 'blocked')
      case 'failed': return view('failed')
    }
  }
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
  if (issue.status === TASK_REVIEW_STATUS || issue.metadata.pullRequests.some(pr => OPEN_TASK_PR_STATES.some(state => state === pr.state))) return view('waiting', 'pr_review')
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

/**
 * What a task's Agent is doing, shown as a small mark beside the task's status and never as a status, a group or a
 * column (decision 2026-11-13-1405): `working` while a run is queued or under way, `waiting` when it has stopped for
 * the person (a question, an approval, a PR to review, a login, quota), `error` when the run failed. Null otherwise.
 */
export type RunIndicator = 'working' | 'waiting' | 'error'
export function runIndicatorOf(state: TaskState | 'idle'): RunIndicator | null {
  switch (state) {
    case 'running': case 'queued': return 'working'
    case 'waiting': case 'blocked': return 'waiting'
    case 'failed': return 'error'
    default: return null
  }
}
