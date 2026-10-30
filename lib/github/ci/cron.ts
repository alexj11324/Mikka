import 'server-only'
import type { CiReconcileResult } from './reconcile'

export type CiCronOutcome = ({ status: 'ok'; escalationsRetried: number } & CiReconcileResult) | { status: 'failed' }

/** The briefing cron's CI sub-task (MIKKA_CI_RESUME_ENABLED only). It never
 * throws: its outcome is reported in the body and never changes the cron's
 * status, so the briefing work and the CI reconcile stay isolated. Errors are
 * logged by name only. */
export async function runCiReconcileCron(options: { deadline: number }): Promise<CiCronOutcome> {
  try {
    const [{ pool }, { reconcileCi }, { retryPendingCiEscalations }] = await Promise.all([import('@/lib/db'), import('./reconcile'), import('./escalation-recovery')])
    const [observations, escalations] = await Promise.all([reconcileCi({ pool, deadline: options.deadline, limit: 4 }), retryPendingCiEscalations({ pool, deadline: options.deadline })])
    if (observations.failed || escalations.failed) console.error('GitHub CI reconcile had failures', { observations: observations.failed, escalations: escalations.failed })
    return { status: 'ok', ...observations, failed: observations.failed + escalations.failed, escalationsRetried: escalations.attempted }
  } catch (error) {
    console.error('GitHub CI reconcile failed', error instanceof Error ? error.name : typeof error)
    return { status: 'failed' }
  }
}
