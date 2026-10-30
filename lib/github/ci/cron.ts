import 'server-only'
import type { CiReconcileResult } from './reconcile'

export type CiCronOutcome = ({ status: 'ok' } & CiReconcileResult) | { status: 'failed' }

/** The briefing cron's CI sub-task (MIKKA_CI_RESUME_ENABLED only). It never
 * throws: its outcome is reported in the body and never changes the cron's
 * status, so the briefing work and the CI reconcile stay isolated. Errors are
 * logged by name only. */
export async function runCiReconcileCron(options: { deadline: number }): Promise<CiCronOutcome> {
  try {
    const [{ pool }, { reconcileCi }] = await Promise.all([import('@/lib/db'), import('./reconcile')])
    const observations = await reconcileCi({ pool, deadline: options.deadline, limit: 4 })
    if (observations.failed) console.error('GitHub CI reconcile had failures', { failed: observations.failed })
    return { status: 'ok', ...observations }
  } catch (error) {
    console.error('GitHub CI reconcile failed', error instanceof Error ? error.name : typeof error)
    return { status: 'failed' }
  }
}
