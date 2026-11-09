import 'server-only'
import type { PoolClient } from 'pg'

export interface FactoryComputerSession {
  id: string
  runId: string
  startedAt: string
  endedAt: string | null
  reason: 'paused' | 'retired' | 'provider_missing' | 'transferred' | 'replaced' | 'scope_changed' | null
  /** A recorded runningSince, observation of a new binding, or the one proven legacy interval. */
  source: 'running_since' | 'observed' | 'running_since_backfill'
}

/** Called inside the same authorized Factory task read. Keep historical rows
 * scoped even after current thread-machine custody moves to the next run. */
export async function readFactoryComputerSessions(
  tx: Pick<PoolClient, 'query'>,
  task: { id: string; userId: string; issueId: string },
): Promise<FactoryComputerSession[]> {
  const { rows } = await tx.query<Omit<FactoryComputerSession, 'startedAt' | 'endedAt'> & {
    startedAt: Date | string; endedAt: Date | string | null
  }>(`SELECT s.id,s."runId",s."startedAt",s."endedAt",s.reason,s.source
    FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN thread_machine_sessions s ON s."runId"=r.id AND s."ownerId"=r."userId"
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=s."ownerId"
      AND b."workspaceId"=s."workspaceId" AND b."botId" IS NOT DISTINCT FROM s."botId"
    JOIN bots runtime ON runtime.id=b."botId" AND runtime."ownerId"=b."ownerId" AND runtime."workspaceId"=b."workspaceId"
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3
      AND ((t."botId" IS NULL AND r."botId" IS NULL) OR EXISTS (
        SELECT 1 FROM bots source WHERE source.id=t."botId" AND source."ownerId"=s."ownerId" AND source."workspaceId"=s."workspaceId"
          AND (r."botId" IS NULL OR r."botId"=t."botId" OR r."botId"=b."botId")))
      AND (r."agentDefinition"#>>'{executionIdentity,workspaceId}' IS NULL
        OR r."agentDefinition"#>>'{executionIdentity,workspaceId}'=s."workspaceId"::text)
    ORDER BY s."startedAt",s.id`, [task.id, task.userId, task.issueId])
  return rows.map(row => ({ ...row, startedAt: new Date(row.startedAt).toISOString(),
    endedAt: row.endedAt === null ? null : new Date(row.endedAt).toISOString() }))
}
