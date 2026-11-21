import type { CoordinatorEventTier } from '../db/schema'
import type { DecisionExecution } from './decide'
import type { DecisionFailureReason } from './decision-failure'

/** Longer than the whole classification budget, so an in-flight attempt is not
 * immediately reclaimed by another wake. This is transport scheduling only. */
export const TRIAGE_RETRY_COOLDOWN_MS = 15_000
export const TRIAGE_BATCH_BUDGET_MS = 10_000
export const TRIAGE_ATTEMPTS_PER_WAKE = 2
export const TRIAGE_MODEL_CALLS_PER_WAKE = 8

export interface TriageBatchEvent {
  id: string
  kind: string
  lastTriageAttemptAt?: Date | null
  runId?: string | null
  observedRun?: { id: string; status: string; finishedAt: Date | string | null } | null
}
export interface TriageJudgment {
  tier: CoordinatorEventTier | null
  execution: DecisionExecution | null
  errorReason?: DecisionFailureReason
}
export type TriageCompletion = (TriageJudgment & { tier: CoordinatorEventTier; execution: DecisionExecution })
  | { tier: 'result'; execution: null; method: 'rule'; errorReason: DecisionFailureReason }

export function triageDecisionReceipt(event: TriageBatchEvent, attemptedAt: Date, judgment: TriageCompletion) {
  return { version: 1, eventId: event.id, eventKind: event.kind,
    attemptedAt: attemptedAt.toISOString(), chosenTier: judgment.tier, observedRun: event.observedRun ?? null,
    ...('method' in judgment ? { method: 'rule', reason: 'failed_run_completion', lastErrorReason: judgment.errorReason } : { method: 'model', execution: judgment.execution }) }
}
export interface TriageBatchDependencies<T extends TriageBatchEvent> {
  claim(event: T): Promise<Date | null>
  deliverUser(event: T): Promise<boolean>
  deliverCompletion?(event: T): Promise<boolean>
  /** Transport-only CI hint: the caller must revalidate host-owned source, run and authorization. */
  deliverCiSuite?(event: T): Promise<boolean>
  classify(event: T, signal: AbortSignal): Promise<TriageJudgment>
  complete(event: T, attemptedAt: Date, judgment: TriageCompletion): Promise<boolean>
  recordFailure?(event: T, attemptedAt: Date, reason: DecisionFailureReason): Promise<void>
  observe?(event: T, judgment: TriageJudgment, application: 'received' | 'applied' | 'stale' | 'write-unknown'): void
}
export interface TriageBatchOutcome {
  classified: string[]
  pending: string[]
  stale: string[]
  unattempted: string[]
}
function hasReceipt(value: TriageJudgment): boolean {
  return typeof value.execution?.executionId === 'string' && value.execution.executionId.length > 0
    && typeof value.execution.providerGenerationId === 'string' && value.execution.providerGenerationId.length > 0
    && typeof value.execution.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(value.execution.requestDigest)
}
function hasObservation(value: TriageJudgment): value is TriageJudgment & { tier: CoordinatorEventTier; execution: DecisionExecution } {
  return ['attention', 'result', 'background'].includes(value.tier ?? '') && hasReceipt(value)
}

/** Actual wake scheduling, independent of framework/loaders. A model chooses
 * semantic runtime tiers; direct input and canonical task results are transport. Program checks only transport, budgets and CAS outcomes.
 * Only host-verified failed completions may bypass a missing model answer. */
export async function runTriageBatch<T extends TriageBatchEvent>(
  events: readonly T[], dependencies: TriageBatchDependencies<T>, signal: AbortSignal,
): Promise<TriageBatchOutcome> {
  const outcome: TriageBatchOutcome = { classified: [], pending: [], stale: [], unattempted: [] }
  let remainingCalls = TRIAGE_MODEL_CALLS_PER_WAKE
  for (const event of events) {
    if (event.kind === 'user_message') {
      const applied = await dependencies.deliverUser(event)
      outcome[applied ? 'classified' : 'stale'].push(event.id)
      continue
    }
    // A canonical result returns to the Bot that requested the work. Its
    // original subscription can handle it without buying another model call.
    const completionDelivered = event.kind === 'run_finished' ? await dependencies.deliverCompletion?.(event) : undefined
    if (completionDelivered) {
      outcome.classified.push(event.id)
      continue
    }
    // A source-verified suite receipt is a host transport observation, not a
    // semantic classification requiring an additional paid model call.
    if (event.kind === 'run_report' && await dependencies.deliverCiSuite?.(event)) {
      outcome.classified.push(event.id)
      continue
    }
    if (signal.aborted || remainingCalls === 0) { outcome.unattempted.push(event.id); continue }
    // Claim before inference. A later wake can advance past a slow event even
    // if this process exits before receiving or persisting its model response.
    const attemptedAt = await dependencies.claim(event)
    if (!attemptedAt) { outcome.stale.push(event.id); continue }
    let judgment: TriageJudgment = { tier: null, execution: null }
    let attempted = false
    const failedCompletion = completionDelivered === false && event.observedRun?.id === event.runId
      && event.observedRun?.status === 'failed' && event.observedRun.finishedAt != null
    for (let attempt = 0; attempt < TRIAGE_ATTEMPTS_PER_WAKE && remainingCalls > 0 && !signal.aborted; attempt++) {
      remainingCalls--
      attempted = true
      try { judgment = await dependencies.classify(event, signal) }
      catch { judgment = { tier: null, execution: null, errorReason: 'classification_failed' } }
      if (hasReceipt(judgment)) dependencies.observe?.(event, judgment, 'received')
      if (hasObservation(judgment)) break
      await dependencies.recordFailure?.(event, attemptedAt, judgment.errorReason ?? 'decision_unavailable')
      if (failedCompletion) break
    }
    let completion: TriageCompletion
    if (!signal.aborted && hasObservation(judgment)) completion = judgment
    else if (failedCompletion && attempted && !hasObservation(judgment)) completion = { tier: 'result', execution: null, method: 'rule', errorReason: judgment.errorReason ?? 'decision_unavailable' }
    else {
      outcome.pending.push(event.id)
      continue
    }
    let applied: boolean
    try { applied = await dependencies.complete(event, attemptedAt, completion) }
    catch (error) {
      // A lost database acknowledgment is not proof of a failed commit. Stop
      // this wake; a later scoped read resolves state before another claim.
      if (hasReceipt(completion)) dependencies.observe?.(event, completion, 'write-unknown')
      throw error
    }
    if (hasReceipt(completion)) dependencies.observe?.(event, completion, applied ? 'applied' : 'stale')
    outcome[applied ? 'classified' : 'stale'].push(event.id)
  }
  return outcome
}
