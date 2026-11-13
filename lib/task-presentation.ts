import type { ReviewLineSummary } from './code-review/summary-text'
import type { InboxSource } from './inbox/contract'
import type { IssueStatus } from './issue-meta'
import { taskBlock, type BlockIssue } from './task-blocked'
import type { FactoryFlowView } from './factory/public-flow'
import { taskStateOf, type TaskStateContext, type TaskStateRun, type TaskStateView } from './task-state'

export type TaskPresentation = TaskStateView & {
  version: 1
  /** Missing on cached snapshots from before the Inbox attention projection. */
  inboxReason?: InboxSource['reason']
  /** Opt-in list context for opening the authorized Factory on user selection. */
  factoryTaskId?: string
  /** Reader-owned Bots with a verified dispatch in this Task’s workspace. */
  botDispatches?: { botId: string; runId: string; name: string; harness: string | null }[]
  factoryExtraCount?: number
  review?: ReviewLineSummary
  primaryStatus: IssueStatus
  factoryStage: FactoryFlowView['stage'] | null
  runStatus: string | null
  needsAction: NonNullable<FactoryFlowView['needsYou']>['kind'] | 'dependency' | 'flagged' | 'quota' | null
  blockedReason: NonNullable<ReturnType<typeof taskBlock>>['reason'] | 'factory' | null
  completion: 'merged' | 'accepted' | null
}
/** Board attention is personal (including snooze and dismissal); task lifecycle is shared. */
export function boardActivityState(task: TaskPresentation): TaskStateView {
  if (task.inboxReason === undefined) return task
  if (task.inboxReason === null) return task.group === 'pending' ? { ...task, state:'todo', reason:null, group:'todo' } : task
  const common = { group: 'pending' as const, blockedBy: null }
  switch (task.inboxReason) {
    case 'needsReply': return { ...common, state:'waiting', reason:'needs_input' }
    case 'confirm': return { ...common, state:'waiting', reason:'approval' }
    case 'review': return { ...common, state:'waiting', reason:'pr_review' }
    case 'offline': case 'quota': return { ...common, state:'blocked', reason:task.inboxReason }
    case 'failed': return { ...common, state:'failed', reason:null }
    default: return { ...common, state:'blocked', reason:'blocked' }
  }
}

type PresentationContext = Pick<TaskStateContext, 'schedule'> & { blockerIdentifier?: (id: string) => string | null }

/** This projection describes work; it does not authorize approval or change
 * Task state. A successful Run alone never proves delivery or PR merge. */
export function taskPresentation(issue: BlockIssue & { status: IssueStatus }, run: TaskStateRun | undefined,
  flow: Pick<FactoryFlowView, 'stage' | 'needsYou' | 'completion'> | null, isOpen: (id: string) => boolean,
  context: PresentationContext = {}): TaskPresentation {
  const closed = ['done', 'canceled', 'duplicate'].includes(issue.status)
  const block = taskBlock(issue, run, isOpen)
  if (block?.blockerId) block.blockerIdentifier = context.blockerIdentifier?.(block.blockerId) ?? null
  const state = taskStateOf(issue, run, { block, schedule: context.schedule, factory: flow })
  const factoryNeed = !closed && flow?.stage !== 'completed' && flow?.stage !== 'cancelled' ? flow?.needsYou?.kind : undefined
  let needsAction: TaskPresentation['needsAction'] = null
  let blockedReason: TaskPresentation['blockedReason'] = null
  // These compatibility labels describe the same classification; they never
  // infer a second display state from status/outcome. Generic approval has no
  // old label value: clients use state/reason, not Boolean(needsAction).
  if (factoryNeed) {
    needsAction = factoryNeed
    blockedReason = factoryNeed === 'blocked' || factoryNeed === 'failed' ? 'factory'
      : factoryNeed === 'question' && block?.reason === 'question' ? 'question' : null
  } else if (!closed) {
    const cleared = issue.metadata.block?.blocked === false && issue.metadata.block.runId === (run?.runId ?? null)
    if (state.reason === 'blocked_by' || state.reason === 'flagged') {
      needsAction = blockedReason = state.reason === 'blocked_by' ? 'dependency' : 'flagged'
    } else if (!cleared) {
      if (state.state === 'waiting' && state.reason === 'needs_input') {
        needsAction = 'question'; blockedReason = block?.reason === 'question' ? 'question' : null
      } else if (state.state === 'waiting' && state.reason === 'pr_review') needsAction = 'pr_review'
      else if (state.state === 'blocked') {
        needsAction = state.reason === 'quota' ? 'quota' : 'blocked'
        blockedReason = state.reason === 'quota' ? 'quota' : 'run'
      } else if (state.state === 'failed') { needsAction = 'failed'; blockedReason = 'failed' }
    }
  }
  return { version: 1, ...state, primaryStatus: issue.status, factoryStage: flow?.stage ?? null, runStatus: run?.status ?? null,
    needsAction, blockedReason,
    completion: flow?.stage === 'completed' ? flow.completion ?? null : null }
}
