export async function maintainThreadMachine(actor: { userId: string; workspaceId: string }, runId: string) {
  'use step'
  const { pool } = await import('@/lib/db')
  const { threadMachineAction } = await import('@/lib/cloud-computer/thread-machines')
  const { connectComputer } = await import('@/lib/computer/e2b-provider')
  const row = (await pool.query(`SELECT m.*,r.status,r."updatedAt" FROM thread_machines m JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
    WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3`, [runId, actor.userId, actor.workspaceId])).rows[0]
  if (!row || row.state === 'ended') return false
  if (['succeeded', 'failed', 'stopped', 'cancelled'].includes(row.status)) {
    await threadMachineAction(pool, actor, runId, 'end')
    await pool.query('UPDATE suggestion_executions SET status=$2,"endedAt"=now() WHERE "runId"=$1', [runId, row.status === 'succeeded' ? 'done' : row.status === 'cancelled' ? 'stopped' : row.status])
    return false
  }
  if (row.state === 'paused') return false
  if (row.state === 'running' && row.sandboxId) {
    if (row.status === 'queued' && Date.now() - new Date(row.lastActiveAt).getTime() >= 15 * 60_000) {
      await threadMachineAction(pool, actor, runId, 'pause')
      return false
    }
    // Do not let the provider's timeout suspend an active native process with
    // a live 90-second run lease. Only an idle, unclaimed machine is paused.
    await (await connectComputer(actor.workspaceId, row.sandboxId)).setTimeout(15 * 60_000)
  }
  return true
}
