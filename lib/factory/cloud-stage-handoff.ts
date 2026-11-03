import 'server-only'
import type { Pool } from 'pg'
import { factoryAutomaticRuntime } from './automatic-dispatch'

type Actor = { userId: string; workspaceId: string }

/** Host-only durable work: never called inside the completed worker's request. */
export async function handoffFactoryCloudStage(pool: Pool, actor: Actor, previousRunId: string | null, runId: string) {
  const { rowCount } = await pool.query(`SELECT 1 FROM factory_tasks t
    JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 AND t.status='running'
      AND r.status='queued' AND r."stopRequestedAt" IS NULL
      AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM agent_runs previous WHERE previous.id=$4
        AND previous."userId"=r."userId" AND previous."issueId"=r."issueId"
        AND previous.status IN ('succeeded','failed','stopped','cancelled')))`, [runId, actor.userId, actor.workspaceId, previousRunId])
  if (!rowCount) return false // A cancelled, superseded or already-started handoff has no work.
  try { if (previousRunId) await factoryAutomaticRuntime.park(pool, actor, previousRunId) }
  catch {
    await failFactoryCloudStage(pool, actor, runId, 'Previous stage artifacts could not be retained')
    return false
  }
  const started = await factoryAutomaticRuntime.start(actor, runId)
  // Exact native continuations retain their original VM on transient wake
  // failure. Retry this existing durable step instead of claiming success.
  if (started?.state === 'unavailable') throw new Error('Original question machine unavailable')
  return true
}

export async function failFactoryCloudStage(pool: Pool, actor: Actor, runId: string, message: string) {
  const { rows: [ended] } = await pool.query(`UPDATE agent_runs r SET status='failed',"stopReason"='device_lost',error=$4,"finishedAt"=now(),"updatedAt"=now()
    WHERE r.id=$1 AND r."userId"=$2 AND r.status='queued' AND EXISTS (
      SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."ownerId"=r."userId" AND b."workspaceId"=$3) RETURNING r.*`, [runId, actor.userId, actor.workspaceId, message])
  if (!ended) return
  const [{ db }, { recordCoordinatorEvent }, { runFinishedEvent }, { wakeCoordinator }, { afterRunEnded }] = await Promise.all([
    import('@/lib/db'), import('@/lib/coordinator-event-store'), import('@/lib/coordinator-events'), import('@/lib/coordinator/wake'), import('@/lib/run-completion-effects'),
  ])
  await recordCoordinatorEvent(db, runFinishedEvent(ended))
  await afterRunEnded(actor.userId, runId)
  await wakeCoordinator(actor.userId).catch(() => undefined)
}
