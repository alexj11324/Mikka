import { sweepExpiredRunLeases } from '@/lib/run-leases'
import { reconcileCloudMachines } from '@/lib/computer/reconcile'
import { pool } from '@/lib/db'
import { judgePendingOutcomes } from '@/lib/run-outcome-judge'
import { endClosedTaskMachines } from '@/lib/cloud-computer/thread-machines'
import { retrySandboxKills } from '@/lib/cloud-computer/workspace-teardown'
import { resumePendingGroupTurns } from '@/lib/group-conversations-route'

/**
 * Everything run recovery does, for the run-recovery due timer (lib/due-timer.ts)
 * at its due time and for the slow reconciliation sweep (app/api/cron/run-recovery).
 * `groupTurns` runs the group-turn sweep: after the response in a request, inline
 * in a Workflow step (which has no request to run after).
 */
export async function recoverRuns(groupTurns: (work: () => Promise<unknown>) => unknown) {
  const runs = await sweepExpiredRunLeases()
  // Bot computers whose sandbox E2B no longer has stop claiming to run.
  const machines = await reconcileCloudMachines(pool).catch(() => null)
  // Ended runs never judged (any end path, and the last week before outcomes existed) get their outcome (R-52).
  const outcomes = await judgePendingOutcomes().catch(() => null)
  // Paused task sandboxes whose task closed are killed (one task, one sandbox).
  const taskMachines = await endClosedTaskMachines(pool).catch(() => null)
  // Sandboxes of deleted workspaces whose kill did not go through are killed again.
  const sandboxKills = await retrySandboxKills(pool).catch(() => null)
  // Durable task progress, independent of heartbeat or an open client.
  const tasks = await (await import('@/lib/factory/watchdog')).sweepFactoryWatchdog(pool).catch(() => null)
  // Group turns left queued when their request ended: they no longer wait for someone to read the group.
  const started = Date.now()
  await groupTurns(() => resumePendingGroupTurns(started + 220000).catch(() => console.error('Group turn sweep failed')))
  return { ...runs, machines, outcomes, taskMachines, sandboxKills, tasks }
}
