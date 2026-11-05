// The browser's reading of `GET /api/factory/tasks/:taskId/flow` (#1276) and
// of its `approve_spec` answer. Pure, so the card's states are testable.

import type { StatusTone } from '@/lib/status-appearance'

export const FLOW_STAGES = ['triage', 'spec', 'implement', 'review', 'handoff', 'completed', 'cancelled'] as const
export type FlowStage = typeof FLOW_STAGES[number]
export const NEEDS_YOU_KINDS = ['spec_review', 'question', 'pr_review', 'blocked', 'failed'] as const
export type NeedsYouKind = typeof NEEDS_YOU_KINDS[number]

export interface FactoryFlow {
  version: 2
  id: string
  issueId: string
  botId: string | null
  revision: number
  stage: FlowStage
  stages: FlowStage[]
  needsYou?: { kind: NeedsYouKind; since: string }
  review: { verdict: 'passed' | 'changes_requested' | 'needs_judgment' | null; candidateId: string | null; currentCandidateReviewed: boolean } | null
  acceptance: { artifactId: string; version: number; runId: string; candidateId: string; counts: Partial<Record<'passed' | 'failed' | 'unverified', number>>; media: unknown[] } | null
  pullRequest: { url: string; state: string } | null
}

export const flowKey = (taskId: string) => `/api/factory/tasks/${taskId}/flow`

const isStage = (value: unknown): value is FlowStage => FLOW_STAGES.includes(value as FlowStage)

/** A body that is not the v2 projection (an HTML fallback, an older server) reads as no flow. */
export function readFlow(value: unknown): FactoryFlow | null {
  if (!value || typeof value !== 'object') return null
  const flow = value as Partial<FactoryFlow>
  if (flow.version !== 2 || typeof flow.id !== 'string' || typeof flow.revision !== 'number' || !isStage(flow.stage)) return null
  const stages = Array.isArray(flow.stages) ? flow.stages.filter(isStage) : []
  const needsYou = flow.needsYou && NEEDS_YOU_KINDS.includes(flow.needsYou.kind) ? flow.needsYou : undefined
  return { ...flow, stages: stages.includes(flow.stage) ? stages : [...stages, flow.stage], needsYou, review: flow.review ?? null, acceptance: flow.acceptance ?? null, pullRequest: flow.pullRequest ?? null } as FactoryFlow
}

/** R-87: needing the person is amber, a stop is red, and a merge is the finished green. */
export function flowTone(flow: Pick<FactoryFlow, 'stage' | 'needsYou'>): StatusTone {
  if (flow.needsYou) return flow.needsYou.kind === 'blocked' || flow.needsYou.kind === 'failed' ? 'destructive' : 'warning'
  return flow.stage === 'completed' ? 'success' : flow.stage === 'cancelled' ? 'neutral' : 'info'
}

/** Only a GitHub pull request link is offered as one. */
export const pullRequestLink = (flow: Pick<FactoryFlow, 'pullRequest'>) =>
  flow.pullRequest && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(flow.pullRequest.url) ? flow.pullRequest.url : null

/**
 * What an `approve_spec` refusal means to the person. `stale`: the task moved
 * on (a newer revision), so the card reloads and a new click is a new event.
 * `unknown`: no answer arrived; the server may have approved, so the same
 * click (same eventId) is retried and its receipt comes back.
 */
export type ApproveSpecError = 'stale' | 'transition' | 'evidence' | 'signedOut' | 'notFound' | 'unknown'
export function approveSpecError(code: string | null, status: number | null): ApproveSpecError {
  switch (code) {
    case 'factoryStale': case 'factoryReplayMismatch': return 'stale'
    case 'factoryTransition': return 'transition'
    case 'factoryEvidenceRequired': return 'evidence'
    case 'factoryHumanRequired': case 'originRejected': return 'signedOut'
    case 'factoryNotFound': return 'notFound'
  }
  return status === 401 || status === 403 ? 'signedOut' : status === 404 ? 'notFound' : 'unknown'
}

/** A successful approval: the host's receipt for this click, now in 实现. */
export function approveSpecConfirmed(value: unknown, taskId: string): boolean {
  if (!value || typeof value !== 'object') return false
  const receipt = value as { binding?: { taskId?: unknown; revision?: unknown }; stage?: unknown }
  return receipt.binding?.taskId === taskId && typeof receipt.binding.revision === 'number' && receipt.stage === 'implement'
}
