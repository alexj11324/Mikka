import 'server-only'
import type { PoolClient } from 'pg'
import { taskActivityChanged } from '../factory/activity-live'

export interface ThreadMachineSessionScope {
  runId: string
  ownerId: string
  workspaceId: string
  sandboxId: string
  operationId: string
}

const scopeValues = (scope: ThreadMachineSessionScope) =>
  [scope.runId, scope.ownerId, scope.workspaceId, scope.sandboxId, scope.operationId]

/** The retained-delivery observer must keep custody state=paused while it
 * briefly resumes the VM. Record provider-confirmed observations separately,
 * inside its existing bounded custody transaction, without changing that row. */
export async function recordThreadMaintenanceSession(tx: Pick<PoolClient, 'query'>,
  scope: ThreadMachineSessionScope, leaseId: string, observation: 'running' | 'paused'): Promise<boolean> {
  const held = `WITH parent AS MATERIALIZED (SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR KEY SHARE),
    held AS MATERIALIZED (SELECT m.* FROM thread_machines m JOIN parent ON parent.id=m."runId"
    WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m."sandboxId"=$4 AND m."operationId"=$5
      AND m."workerLeaseId"=$6 AND m."workerLeaseUntil">clock_timestamp() AND m.state='paused' AND m."runningSince" IS NULL
    FOR UPDATE OF m)`
  const write = observation === 'running'
    ? `INSERT INTO thread_machine_sessions("runId","ownerId","workspaceId","botId","sandboxId","startedAt",source)
       SELECT "runId","ownerId","workspaceId","botId","sandboxId",clock_timestamp(),'observed' FROM held
       ON CONFLICT ("runId") WHERE "endedAt" IS NULL DO NOTHING RETURNING id`
    : `UPDATE thread_machine_sessions s SET "endedAt"=GREATEST(s."startedAt",clock_timestamp()),reason='paused'
       FROM held m WHERE s."runId"=m."runId" AND s."ownerId"=m."ownerId" AND s."workspaceId"=m."workspaceId"
         AND s."botId" IS NOT DISTINCT FROM m."botId" AND s."sandboxId"=m."sandboxId" AND s."endedAt" IS NULL RETURNING s.id`
  const { rows: [result] } = await tx.query<{ held: boolean; changed: boolean }>(`${held}, changed AS (${write})
    SELECT EXISTS(SELECT 1 FROM held) AS held,EXISTS(SELECT 1 FROM changed) AS changed`, [...scopeValues(scope),leaseId])
  if (result.changed) taskActivityChanged(tx, scope.runId)
  return result.held
}

/** A late create can finish after cancellation. Preserve the existing cleanup
 * owner and row while closing its interval only after this exact VM's kill ACK. */
export async function recordCancelledThreadSessionEnd(tx: Pick<PoolClient, 'query'>, scope: ThreadMachineSessionScope) {
  const { rowCount } = await tx.query(`WITH held AS MATERIALIZED (SELECT m.* FROM thread_machines m
      WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m."sandboxId"=$4 AND m."operationId"=$5 AND m.state='ended'
      FOR UPDATE OF m)
    UPDATE thread_machine_sessions s SET "endedAt"=GREATEST(s."startedAt",clock_timestamp()),reason='retired'
    FROM held m WHERE s."runId"=m."runId" AND s."ownerId"=m."ownerId" AND s."workspaceId"=m."workspaceId"
      AND s."botId" IS NOT DISTINCT FROM m."botId" AND s."sandboxId"=m."sandboxId" AND s."endedAt" IS NULL`, scopeValues(scope))
  if (rowCount) taskActivityChanged(tx, scope.runId)
  return Boolean(rowCount)
}

export interface FactoryComputerSession {
  id: string
  runId: string
  startedAt: string
  endedAt: string | null
  reason: 'paused' | 'retired' | 'provider_missing' | 'transferred' | 'replaced' | 'scope_changed' | null
  /** A recorded runningSince, provider-confirmed observation, or the one proven legacy interval. */
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
      AND r."workspaceId"=t."workspaceId"
    JOIN thread_machine_sessions s ON s."runId"=r.id AND s."ownerId"=r."userId" AND s."workspaceId"=r."workspaceId"
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
