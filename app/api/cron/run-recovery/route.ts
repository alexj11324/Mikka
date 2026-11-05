import { cronUnauthorized } from '@/lib/cron-auth'
import { afterJob, cronJob } from '@/lib/background'
import { sweepExpiredRunLeases } from '@/lib/run-leases'
import { reconcileCloudMachines } from '@/lib/computer/reconcile'
import { pool } from '@/lib/db'
import { judgePendingOutcomes } from '@/lib/run-outcome-judge'
import { endClosedTaskMachines } from '@/lib/cloud-computer/thread-machines'
import { retrySandboxKills } from '@/lib/cloud-computer/workspace-teardown'
import { resumePendingGroupTurns } from '@/lib/group-conversations-route'

export const runtime = 'nodejs'
// The group-turn sweep keeps generating after the answer, as a message request does.
export const maxDuration = 300
const headers = { 'cache-control': 'no-store' }

/** The existing cron Worker calls this independently of owner/device requests. */
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try {
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
    afterJob('cron:run-recovery/group-turns', () => resumePendingGroupTurns(started + 220000).catch(() => console.error('Group turn sweep failed')))
    return Response.json({ ...runs, machines, outcomes, taskMachines, sandboxKills, tasks }, { headers })
  }
  catch { return Response.json({ error: 'runRecoverySweepFailed' }, { status: 502, headers }) }
}

export const GET = cronJob('run-recovery', handleGET)
