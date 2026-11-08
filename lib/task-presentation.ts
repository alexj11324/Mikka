import type { IssueStatus } from './issue-meta'
import { taskBlock, type BlockIssue, type BlockRun } from './task-blocked'
import type { FactoryFlowView } from './factory/public-flow'

export type TaskPresentation = {
  version: 1
  primaryStatus: IssueStatus
  factoryStage: FactoryFlowView['stage'] | null
  runStatus: string | null
  needsAction: NonNullable<FactoryFlowView['needsYou']>['kind'] | 'dependency' | 'flagged' | 'quota' | null
  blockedReason: NonNullable<ReturnType<typeof taskBlock>>['reason'] | 'factory' | null
  completion: 'merged' | 'accepted' | null
}

/** This projection describes work; it does not authorize approval or change
 * Task state. A successful Run alone never proves delivery or PR merge. */
export function taskPresentation(issue: BlockIssue & { status: IssueStatus }, run: BlockRun | undefined,
  flow: Pick<FactoryFlowView, 'stage' | 'needsYou' | 'completion'> | null, isOpen: (id: string) => boolean): TaskPresentation {
  const closed = ['done', 'canceled', 'duplicate'].includes(issue.status)
  const block = taskBlock(issue, run, isOpen)
  const needs = closed ? null : flow?.needsYou?.kind ?? (block?.reason === 'question' ? 'question'
    : block?.reason === 'failed' ? 'failed' : block?.reason === 'run' ? 'blocked' : block?.reason ?? null)
  return { version: 1, primaryStatus: issue.status, factoryStage: flow?.stage ?? null, runStatus: run?.status ?? null,
    needsAction: needs, blockedReason: block?.reason ?? (!closed && ['blocked', 'failed'].includes(flow?.needsYou?.kind ?? '') ? 'factory' : null),
    completion: flow?.stage === 'completed' ? flow.completion ?? null : null }
}
