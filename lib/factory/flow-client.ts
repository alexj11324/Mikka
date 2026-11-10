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
  completion?: 'merged' | 'accepted'
  review: { verdict: 'passed' | 'changes_requested' | 'needs_judgment' | null; candidateId: string | null; currentCandidateReviewed: boolean; summary?: import('./public-flow').FactoryReviewSummary | null } | null
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

/** The closed set of reasons the host gives with `agentProfileModelUnavailable` (lib/factory/agent-profile.ts). */
export const PROFILE_MODEL_DETAILS = ['checking', 'quota', 'expired', 'paused', 'missing', 'removed', 'model_gone', 'key_refused', 'balance', 'provider_unavailable'] as const
export type ProfileModelDetail = typeof PROFILE_MODEL_DETAILS[number]

/** Decision reasons returned when the host cannot select an executor Profile. */
const PROFILE_DECISION_DETAILS = ['decision_unavailable', 'no_suitable_profile', 'invalid_profile_answer', 'unknown_profile', 'uncertain_profile', 'invalid_reason'] as const
type ProfileDecisionDetail = typeof PROFILE_DECISION_DETAILS[number]

/**
 * What an `approve_spec` answer means to the person. Every answer the server
 * actually gave is final for that click: `stale` (the task moved on), the
 * Factory refusals, an executor Profile or its model being unavailable, or any
 * other coded refusal. Only `unknown` (no answer, or a server error) keeps the
 * click: the server may have approved, so the same eventId is sent again and
 * its receipt comes back.
 */
export type ApproveSpecError = 'stale' | 'transition' | 'evidence' | 'signedOut' | 'notFound' | 'profileModel' | 'profile' | 'refused' | 'unknown'
export interface ApproveSpecFailure { kind: ApproveSpecError; code: string | null; detail: string | null }

export function approveSpecError(code: string | null, status: number | null, detail: string | null = null): ApproveSpecFailure {
  const failure = (kind: ApproveSpecError): ApproveSpecFailure => ({ kind, code, detail: kind === 'unknown' ? null : detail })
  switch (code) {
    case 'factoryStale': case 'factoryReplayMismatch': return failure('stale')
    case 'factoryTransition': return failure('transition')
    case 'factoryEvidenceRequired': return failure('evidence')
    case 'factoryHumanRequired': case 'originRejected': return failure('signedOut')
    case 'factoryNotFound': return failure('notFound')
    case 'agentProfileModelUnavailable': return failure('profileModel')
  }
  if (status === null || status >= 500) return failure('unknown')
  if (code?.startsWith('agentProfile')) return failure('profile')
  if (status === 401 || status === 403) return failure('signedOut')
  if (status === 404) return failure('notFound')
  return failure('refused')
}

/** The message key under `FactoryFlow.card.approveError` for a failure. */
export function approveSpecErrorKey(failure: ApproveSpecFailure): string {
  if (failure.kind === 'profile') {
    switch (failure.code) {
      case 'agentProfileDisabled': return 'profileDisabled'
      case 'agentProfileArchived': return 'profileArchived'
      case 'agentProfileVersionConflict': return 'profileVersionConflict'
      case 'agentProfileDecisionUnavailable':
        return PROFILE_DECISION_DETAILS.includes(failure.detail as ProfileDecisionDetail) ? 'profileDecision.' + failure.detail : 'profile'
    }
  }
  if (failure.kind !== 'profileModel') return failure.kind
  return `profileModel.${PROFILE_MODEL_DETAILS.includes(failure.detail as ProfileModelDetail) ? failure.detail : 'default'}`
}

/** A coded refusal shows its code (and detail) under 详情; stale and unknown carry nothing to look up. */
export const approveSpecErrorCode = (failure: ApproveSpecFailure) =>
  failure.kind === 'unknown' || failure.kind === 'stale' || !failure.code ? null : failure.detail ? `${failure.code} · ${failure.detail}` : failure.code

/** A successful approval: the host's receipt for this click, now in 实现. */
export function approveSpecConfirmed(value: unknown, taskId: string): boolean {
  if (!value || typeof value !== 'object') return false
  const receipt = value as { binding?: { taskId?: unknown; revision?: unknown }; stage?: unknown }
  return receipt.binding?.taskId === taskId && typeof receipt.binding.revision === 'number' && receipt.stage === 'implement'
}
