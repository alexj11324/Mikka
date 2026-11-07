// Where a thread's Artifact stands (decision 2026-11-06-1615): the header
// button's dot and tooltip, and the subtitle of its card in a chat. Pure, so
// every state is testable without a server.

import type { AcceptanceState } from './acceptance-state'
import type { FactoryFlow } from './flow-client'

/**
 * - `none`: nothing handed over yet (the button is off until the thread finishes).
 * - `preparing`: the run finished; its PR or report is still being made.
 * - `ready`: an Artifact with no PR to review (a plain document or page).
 * - `review`: waiting for your review (amber).
 * - `fixing` / `merging`: a fix run or the merge is going (grey).
 * - `merged`: merged (purple).
 * - `refused`: GitHub refused the merge (red); `blocked`: the task stopped (red).
 */
export type ArtifactReviewKind = 'none' | 'preparing' | 'ready' | 'review' | 'fixing' | 'merging' | 'merged' | 'refused' | 'blocked'

export interface ArtifactReviewInput {
  /** The thread has at least one Artifact. */
  hasArtifact: boolean
  /** The thread's run ended successfully, so an Artifact is on its way. */
  runSucceeded: boolean
  /** The acceptance task's public flow (v2), when the thread's Artifact is its report. */
  flow?: Pick<FactoryFlow, 'stage' | 'needsYou' | 'completion' | 'acceptance'> | null
  /** The candidate's merge state, from the same ledger the acceptance pane reads. */
  merge?: { state: AcceptanceState; refusal?: string } | null
}

export function artifactReviewKind({ hasArtifact, runSucceeded, flow, merge }: ArtifactReviewInput): ArtifactReviewKind {
  if (flow) {
    if (flow.stage === 'completed') return 'merged'
    if (flow.needsYou?.kind === 'blocked' || flow.needsYou?.kind === 'failed') return 'blocked'
    if (merge?.state === 'merging') return 'merging'
    if (merge?.refusal) return 'refused'
    if (flow.needsYou?.kind === 'pr_review') return 'review'
    // A report exists and the task went back to work: the fix run on the same PR.
    if (flow.acceptance && (flow.stage === 'implement' || flow.stage === 'review')) return 'fixing'
    if (flow.stage === 'handoff') return hasArtifact ? 'review' : 'preparing'
  } else if (merge) {
    if (merge.state === 'merged' || merge.state === 'accepted') return 'merged'
    if (merge.state === 'merging') return 'merging'
    if (merge.refusal) return 'refused'
    if (merge.state === 'pending') return 'review'
  }
  if (hasArtifact) return 'ready'
  return runSucceeded ? 'preparing' : 'none'
}

/** The status dot on the button's corner; none while there is nothing to say. */
export function artifactReviewDot(kind: ArtifactReviewKind): 'warning' | 'neutral' | 'merged' | 'destructive' | null {
  if (kind === 'review') return 'warning'
  if (kind === 'fixing' || kind === 'merging') return 'neutral'
  if (kind === 'merged') return 'merged'
  if (kind === 'refused' || kind === 'blocked') return 'destructive'
  return null
}

/** `123` from a GitHub pull request link; null for anything else. */
export function pullNumberOf(url: string | null | undefined): string | null {
  const match = url?.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\/?$/)
  return match ? match[1] : null
}
