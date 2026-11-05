/** The provider pauses an untouched sandbox after 15 minutes; each pass re-arms that. */
const PROVIDER_IDLE_MS = 15 * 60_000
/** With nothing to wake it, a live machine is maintained this often: well inside
 * PROVIDER_IDLE_MS, and the bound on noticing a run that ended without a wake. */
export const MAINTENANCE_FALLBACK_MS = 5 * 60_000

/**
 * One maintenance pass. False when the lifecycle is over; otherwise the epoch
 * ms of the next real deadline (an idle queued machine's pause, or the
 * provider timeout's refresh). The run row changing wakes it sooner
 * (lib/live/panels.ts runChanged, lib/workflow-wake.ts).
 */
export async function maintainThreadMachine(actor: { userId: string; workspaceId: string }, runId: string): Promise<false | number> {
  'use step'
  const { pool } = await import('@/lib/db')
  const { threadMachineAction } = await import('@/lib/cloud-computer/thread-machines')
  const { connectComputer } = await import('@/lib/computer/e2b-provider')
  const row = (await pool.query(`SELECT m.*,r.status,r."updatedAt" FROM thread_machines m JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
    WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3`, [runId, actor.userId, actor.workspaceId])).rows[0]
  if (!row || row.state === 'ended') return false
  if (['succeeded', 'failed', 'stopped', 'cancelled'].includes(row.status)) {
    // A run of an open task leaves its sandbox paused for the task's next run
    // (one task, one sandbox); anything else ends it. A refused pause throws
    // before anything is recorded, and this step runs again.
    const { parkThreadMachine } = await import('@/lib/cloud-computer/thread-machines')
    const open = row.issueId && (await pool.query(`SELECT 1 FROM issues WHERE id=$1 AND status NOT IN ('done','canceled','duplicate') AND content->'attrs'->'mikka'->>'deletedAt' IS NULL`, [row.issueId])).rowCount
    if (open) await parkThreadMachine(pool, actor, runId)
    else await threadMachineAction(pool, actor, runId, 'end')
    await pool.query('UPDATE suggestion_executions SET status=$2,"endedAt"=now() WHERE "runId"=$1', [runId, row.status === 'succeeded' ? 'done' : row.status === 'cancelled' ? 'stopped' : row.status])
    return false
  }
  if (row.state === 'paused') return false
  if (row.state === 'running' && row.sandboxId) {
    const idleAt = new Date(row.lastActiveAt).getTime() + PROVIDER_IDLE_MS
    if (row.status === 'queued' && Date.now() >= idleAt) {
      await threadMachineAction(pool, actor, runId, 'pause')
      return false
    }
    // Do not let the provider's timeout suspend an active native process with
    // a live 90-second run lease. Only an idle, unclaimed machine is paused.
    await (await connectComputer(actor.workspaceId, row.sandboxId)).setTimeout(PROVIDER_IDLE_MS)
    if (row.status === 'queued') return Math.min(idleAt, Date.now() + MAINTENANCE_FALLBACK_MS)
  }
  return Date.now() + MAINTENANCE_FALLBACK_MS
}

/** The lifecycle's 12-hour cap: an idle machine is paused (free, kept), an active one is left to its lease. */
export async function pauseAtCap(actor: { userId: string; workspaceId: string }, runId: string) {
  'use step'
  const { pool } = await import('@/lib/db')
  const { threadMachineAction } = await import('@/lib/cloud-computer/thread-machines')
  const row = (await pool.query(`SELECT m.state,r.status FROM thread_machines m JOIN agent_runs r ON r.id=m."runId" WHERE m."runId"=$1 AND m."ownerId"=$2`, [runId, actor.userId])).rows[0]
  if (row?.state === 'running' && row.status === 'queued') await threadMachineAction(pool, actor, runId, 'pause').catch(() => undefined)
}
