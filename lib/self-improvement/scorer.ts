import { digest } from './contract'

export const SCORER = Object.freeze({
  id: 'run-feedback', version: 1,
  rule: 'negative-feedback-or-report-verify-failed; positive-only-is-unknown; missing-is-unknown',
  distinctFailures: 25, oldestFailureDays: 7,
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
