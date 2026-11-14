import type { Pool } from 'pg'
import { isTerminalRunState, TERMINAL_RUN_STATES } from '@mikka/protocol/run-state'

type CompletionEvent = {
  id: string; userId: string; botId: string | null; kind: string
  runId: string | null; issueId: string | null; createdAt: Date
  payload: Record<string, unknown>
  /** Supplied by the existing visibleRuns gate, never by event prose. */
  observedRun?: { id: string; status: string; finishedAt: Date | string | null } | null
}

/** Return the result of this Bot's own dispatched request. This is delivery,
 * not a semantic judgment, approval, publication receipt or billing fallback.
 * Unrelated/hidden runs and agent-authored messages still require triage. */
export async function deliverRunCompletion(
  pool: Pick<Pool, 'query'>, event: CompletionEvent, scope: { userId: string; botId: string },
  workspacePool: Pick<Pool, 'connect'>,
): Promise<boolean> {
  const run = event.observedRun
  if (event.kind !== 'run_finished' || event.userId !== scope.userId || event.botId !== scope.botId ||
    !run || run.id !== event.runId || !isTerminalRunState(run.status) || !run.finishedAt) return false
  const bot = (await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [scope.botId, scope.userId])).rows[0]
  if (!bot) return false
  // Workspace membership lives in its own database. Hold its ordinary row
  // lock only across the application CAS; no provider I/O occurs here.
  const membership = await workspacePool.connect()
  try {
    await membership.query('BEGIN')
    const allowed = await membership.query(`SELECT 1 FROM mikka_workspace_members
      WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`, [bot.workspaceId, scope.userId])
    if (!allowed.rowCount) { await membership.query('COMMIT'); return false }
    const result = await pool.query(`UPDATE coordinator_events e SET tier='result',
    "triageDecision"=jsonb_build_object('version',1,'method','run_completion_delivery',
      'eventId',e.id,'eventKind',e.kind,'runId',r.id,'runStatus',r.status,'finishedAt',r."finishedAt")
    FROM agent_runs r JOIN bots b ON b.id=r."botId" AND b."ownerId"=r."userId"
    WHERE e.id=$1 AND e."userId"=$2 AND e."botId"=$3::uuid AND e.kind='run_finished'
      AND e."runId"=$4::uuid AND e."issueId" IS NOT DISTINCT FROM $5::uuid
      AND e.payload=$6::jsonb AND date_trunc('milliseconds',e."createdAt")=$7
      AND e."deliveredAt" IS NULL AND e.tier IS NULL
      AND r.id=e."runId" AND r."userId"=e."userId" AND r."botId"=e."botId"
      AND r."issueId" IS NOT DISTINCT FROM e."issueId"
      AND r.status=ANY($8::text[]) AND r."finishedAt" IS NOT NULL
      AND r.status=$9 AND date_trunc('milliseconds',r."finishedAt")=$10
      AND e.payload->>'status'=r.status AND e.payload->>'stopReason'=r."stopReason"
      AND b."workspaceId"=$11::uuid
    RETURNING e.id`, [event.id, scope.userId, scope.botId, event.runId, event.issueId,
    JSON.stringify(event.payload), event.createdAt, TERMINAL_RUN_STATES, run.status, run.finishedAt, bot.workspaceId])
    await membership.query('COMMIT')
    return result.rowCount === 1
  } catch (error) {
    await membership.query('ROLLBACK')
    throw error
  } finally { membership.release() }
}
