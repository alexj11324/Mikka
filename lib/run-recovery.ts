import { sweepExpiredRunLeases } from '@/lib/run-leases'
import { reconcileCloudMachines } from '@/lib/computer/reconcile'
import { pool } from '@/lib/db'
import { judgePendingOutcomes } from '@/lib/run-outcome-judge'
import { reconcileDueThreadMachines } from '@/lib/cloud-computer/thread-lifecycle-due'
import { retrySandboxKills } from '@/lib/cloud-computer/workspace-teardown'
import { resumePendingGroupTurns } from '@/lib/group-conversations-route'
import type { RunRecoverySweep } from '@/lib/run-recovery-due'

/**
 * Everything run recovery does, for the run-recovery due timer (lib/due-timer.ts)
 * at its due time and for the slow reconciliation sweep (app/api/cron/run-recovery).
 * `groupTurns` runs the group-turn sweep: after the response in a request, inline
 * in a Workflow step (which has no request to run after). `only` limits the pass
 * to the sweeps whose work is due (lib/run-recovery-due.ts, #1371); a skipped
 * sweep reports null.
 */
export async function recoverRuns(groupTurns: (work: () => Promise<unknown>) => unknown, only?: ReadonlySet<RunRecoverySweep>) {
  const runs = (sweep: RunRecoverySweep) => !only || only.has(sweep)
  const leases = runs('leases') ? await sweepExpiredRunLeases() : null
  // Bot computers whose sandbox E2B no longer has stop claiming to run.
  const machines = runs('machines') ? await reconcileCloudMachines(pool).catch(() => null) : null
  // Ended runs never judged (any end path, and the last week before outcomes existed) get their outcome (R-52).
  const outcomes = runs('outcomes') ? await judgePendingOutcomes().catch(() => null) : null
  const reviewSessions = runs('reviewSessions') ? await (await import('./coding-workspace/review-sessions')).expireReviewSessions(pool).catch(() => null) : null
  // The same durable owner follows create/resume, pause retries and retention,
  // including running machines whose individual Workflow ended or disappeared.
  const taskMachines = runs('taskMachines') ? await reconcileDueThreadMachines(pool).catch(() => null) : null
  // Sandboxes of deleted workspaces whose kill did not go through are killed again.
  const sandboxKills = runs('sandboxKills') ? await retrySandboxKills(pool).catch(() => null) : null
  // Durable task progress, independent of heartbeat or an open client.
  const tasks = runs('tasks') ? await (await import('@/lib/factory/watchdog')).sweepFactoryWatchdog(pool).catch(() => null) : null
  // Group turns left queued when their request ended: they no longer wait for someone to read the group.
  const started = Date.now()
  if (runs('groupTurns')) await groupTurns(() => resumePendingGroupTurns(started + 220000).catch(() => console.error('Group turn sweep failed')))
  return { ...(leases ?? { owners: 0, failed: 0 }), machines, outcomes, reviewSessions, taskMachines, sandboxKills, tasks }
}
