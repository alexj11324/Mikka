import { AsyncLocalStorage } from 'node:async_hooks'

export type DecisionFailureReason = 'cancelled' | 'billing_scope_missing' | 'litellm_not_configured'
  | 'admission_refused' | 'billing_refused' | 'preparation_failed' | 'decision_unavailable' | 'classification_failed'

export const decisionFailureScope = new AsyncLocalStorage<{ reason?: DecisionFailureReason }>()

export function recordDecisionFailure(purpose: string, reason: DecisionFailureReason): null {
  const diagnostics = decisionFailureScope.getStore()
  if (diagnostics) diagnostics.reason = reason
  console.error('Decision unavailable', { purpose: purpose.replace(/[^a-z0-9_-]/gi, '').slice(0, 80), reason })
  return null
}
