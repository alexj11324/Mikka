import type { DecisionExecution } from './decide'

/** The API evaluates questions independently. Conditional routing therefore
 * uses separate requests, each with confirmed host state from earlier steps. */
export const GROUP_DECISION_PROTOCOL = 'group-sequential-v1' as const
export const GROUP_MAX_RESPONDERS = 3
export const GROUP_MAX_ROUTING_DECISIONS = GROUP_MAX_RESPONDERS + 1
export const GROUP_RETAINED_DECISIONS = 64
export const groupDecisionPhases = ['intent','responder','delegation','report_timing','legacy_primary'] as const
export const groupDecisionFailures = ['unavailable','missing_or_refused','wrong_answer_type','uncertain','choice_outside_contract','receipt_missing','duplicate_receipt','mention_requires_intervention','reporter_unavailable','call_budget_exhausted','invalid_response','members_unavailable'] as const
export type GroupDecisionPhase = typeof groupDecisionPhases[number]
export type GroupDecisionFailure = typeof groupDecisionFailures[number]
export type GroupDecisionStep = {
  id: string
  phase: GroupDecisionPhase
  index: number
  status: 'complete' | 'invalid_decision' | 'unavailable'
  failure: GroupDecisionFailure | null
  receipt: DecisionExecution | null
  /** Attached only by the host usage-ledger read, never a model answer. */
  decisionCostUsd?: number | null
}

export function groupDecisionTotals(steps: readonly GroupDecisionStep[], omittedCalls = 0) {
  const receipts = new Set<string>()
  let knownUsd = 0, knownCalls = 0, receipted = 0, latency = 0
  for (const step of steps) {
    const generation = step.receipt?.providerGenerationId
    if (generation && receipts.has(generation)) continue
    if (generation) { receipts.add(generation); receipted++; latency += Date.parse(step.receipt!.completedAt) - Date.parse(step.receipt!.startedAt) }
    if (generation && step.decisionCostUsd != null && Number.isFinite(step.decisionCostUsd) && step.decisionCostUsd >= 0) {
      knownUsd += step.decisionCostUsd; knownCalls++
    }
  }
  const attempted = steps.filter(step => !step.receipt).length + receipts.size
  const unknownCalls = attempted - knownCalls
  return {
    decisionCalls: { attempted, receipted, unreceipted: attempted - receipted },
    decisionCost: { knownUsd, knownCalls, unknownCalls, omittedCalls },
    decisionCostUsd: unknownCalls || omittedCalls ? null : knownUsd,
    decisionLatencyMs: receipted === attempted && !omittedCalls ? latency : null,
  }
}
