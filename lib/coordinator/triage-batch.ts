import type { CoordinatorEventTier } from '../db/schema'
import type { DecisionExecution } from './decide'

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
}
export interface TriageJudgment {
  tier: CoordinatorEventTier | null
  execution: DecisionExecution | null
}
export interface TriageBatchDependencies<T extends TriageBatchEvent> {
  claim(event: T): Promise<Date | null>
  deliverUser(event: T): Promise<boolean>
  classify(event: T, signal: AbortSignal): Promise<TriageJudgment>
  complete(event: T, attemptedAt: Date, judgment: TriageJudgment & { tier: CoordinatorEventTier; execution: DecisionExecution }): Promise<boolean>
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
 * every runtime tier. Program checks only transport, budgets and CAS outcomes.
 * No model answer, missing receipt or cancellation can manufacture delivery. */
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
    if (signal.aborted || remainingCalls === 0) { outcome.unattempted.push(event.id); continue }
    // Claim before inference. A later wake can advance past a slow event even
    // if this process exits before receiving or persisting its model response.
    const attemptedAt = await dependencies.claim(event)
    if (!attemptedAt) { outcome.stale.push(event.id); continue }
    let judgment: TriageJudgment = { tier: null, execution: null }
    for (let attempt = 0; attempt < TRIAGE_ATTEMPTS_PER_WAKE && remainingCalls > 0 && !signal.aborted; attempt++) {
      remainingCalls--
      try { judgment = await dependencies.classify(event, signal) }
      catch { judgment = { tier: null, execution: null } }
      if (hasReceipt(judgment)) dependencies.observe?.(event, judgment, 'received')
      if (hasObservation(judgment)) break
    }
    if (signal.aborted || !hasObservation(judgment)) {
      outcome.pending.push(event.id)
      continue
    }
    let applied: boolean
    try { applied = await dependencies.complete(event, attemptedAt, judgment) }
    catch (error) {
      // A lost database acknowledgment is not proof of a failed commit. Stop
      // this wake; a later scoped read resolves state before another claim.
      dependencies.observe?.(event, judgment, 'write-unknown')
      throw error
    }
    dependencies.observe?.(event, judgment, applied ? 'applied' : 'stale')
    outcome[applied ? 'classified' : 'stale'].push(event.id)
  }
  return outcome
}
