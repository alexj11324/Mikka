/** Host rollout gate and kill switch for CI-result resumes (docs/github-ci-subscriptions.md).
 * Off unless exactly '1'. Off means: no watch is registered, the webhook does not
 * read or write CI tables, the cron does not reconcile, failed `workflow_run`
 * deliveries are not redelivered, and an already-queued CI follow-up is retired
 * at claim instead of reaching a model. Importing this module loads nothing. */
export const CI_RESUME_FLAG = 'MIKKA_CI_RESUME_ENABLED'

export function ciResumeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CI_RESUME_FLAG] === '1'
}
