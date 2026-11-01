import { digest } from './contract'

// Version 2: the proposal trigger is the Decision API's `propose` answer
// (lib/self-improvement/proposal-judgment.ts), no longer 25 distinct failures
// or a 7-day-old failure. The one code rule left is the runaway cap. A new
// version is a new immutable improvement_scorers row and a new bucket digest.
export const SCORER = Object.freeze({
  id: 'run-feedback', version: 2,
  rule: 'negative-feedback-or-report-verify-failed; positive-only-is-unknown; missing-is-unknown',
  trigger: 'decision-api-propose-predicate',
  proposalCapHours: 24,
})
export const SCORER_DIGEST = digest(SCORER)

export function score(verdict: 'positive' | 'negative' | 'unknown', report: Record<string, unknown> | null) {
  const verify = report?.verify
  const reportFailed = verify !== null && typeof verify === 'object' && 'status' in verify && verify.status === 'failed'
  return {
    outcome: verdict === 'negative' || reportFailed ? 'failure' as const : 'unknown' as const,
    reason: reportFailed ? 'worker_report_verification_failed' : verdict === 'negative' ? 'untrusted_negative_feedback' : 'insufficient_independent_evidence',
    feedbackTrust: 'untrusted' as const,
  }
}
