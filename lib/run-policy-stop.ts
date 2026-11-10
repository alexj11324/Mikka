import type { PoolClient } from 'pg'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterDatabaseCommit } from './db/commit-effects'
import { notifyDeviceWork } from './device-gateway-notify'
import { armDueTimerAfterCommit } from './due-timer'

export type RunPolicyStopScope =
  | { kind: 'worker'; ownerId: string; agentId: string }
  | { kind: 'agent'; ownerId: string; botId: string | null }
  | { kind: 'workspace'; workspaceId: string; ownerId?: string }
  | { kind: 'team' | 'project'; scopeId: string; ownerId?: string }
  | { kind: 'task'; issueId: string }
  | { kind: 'tasks'; issueIds: string[] }
  | { kind: 'runs'; runIds: string[] }
export type StoppedPolicyRun = { id: string; deviceId: string; stopped: boolean }

/** Direct runners hold their authority on the machine. A policy mutation
 * stops only the affected admitted runs, in that mutation's transaction;
 * provider/tool operations never ask the server to discover the change. */
export function runPolicyStopSQL(scope: RunPolicyStopScope): SQL {
  let where: SQL
  switch (scope.kind) {
    case 'worker': where = sql`r."userId"=${scope.ownerId} AND r."agentId"=${scope.agentId}`; break
    case 'agent': where = sql`r."userId"=${scope.ownerId} AND r."botId" IS NOT DISTINCT FROM ${scope.botId}::uuid`; break
    case 'workspace': where = sql`(r."workspaceId"=${scope.workspaceId}::uuid
      OR (r."workspaceId" IS NULL AND (r."botId" IN (SELECT id FROM bots WHERE "workspaceId"=${scope.workspaceId}::uuid)
        OR r.cli_policy_hierarchy->>'workspaceId'=${scope.workspaceId})))
      ${scope.ownerId ? sql`AND r."userId"=${scope.ownerId}` : sql``}`; break
    case 'team': case 'project': where = sql`r.cli_policy_hierarchy->>${scope.kind === 'team' ? 'teamId' : 'projectId'}=${scope.scopeId}
      ${scope.ownerId ? sql`AND r."userId"=${scope.ownerId}` : sql``}`; break
    case 'task': where = sql`r."issueId"=${scope.issueId}::uuid`; break
    case 'tasks': where = sql`r."issueId"=ANY(${sql.param(scope.issueIds)}::uuid[])`; break
    case 'runs': where = sql`r.id=ANY(${sql.param(scope.runIds)}::uuid[])`; break
  }
  return sql`WITH affected AS MATERIALIZED (
    SELECT r.id,r."deviceId",r."machineAuthority" FROM agent_runs r
    WHERE r."deviceId" IS NOT NULL AND r."stopRequestedAt" IS NULL
      AND r.status IN ('preparing','running','paused','waiting_input','finishing') AND (${where})
    ), stopped AS (
      UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp(),
        "leaseExpiresAt"=LEAST(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
      FROM affected a WHERE r.id=a.id AND a."machineAuthority"=true
        AND r."stopRequestedAt" IS NULL AND r.status IN ('preparing','running','paused','waiting_input','finishing')
      RETURNING r.id
    ) SELECT a.id,a."deviceId",s.id IS NOT NULL AS stopped FROM affected a LEFT JOIN stopped s ON s.id=a.id`
}

/** The statement returned the devices, including legacy runners that still
 * consume a control hint. No follow-up database lookup is needed. */
export function notifyStoppedPolicyRuns(executor: object, rows: readonly StoppedPolicyRun[]) {
  for (const deviceId of new Set(rows.map(row => row.deviceId))) {
    afterDatabaseCommit(executor, `policy-stop:${deviceId}`, () => notifyDeviceWork(deviceId))
  }
  if (rows.some(row => row.stopped)) armDueTimerAfterCommit(executor, 'run-recovery')
}

export async function stopRunsForPolicyChange(executor: Pick<PoolClient, 'query'>, scope: RunPolicyStopScope) {
  const compiled = new PgDialect().sqlToQuery(runPolicyStopSQL(scope))
  const { rows } = await executor.query<StoppedPolicyRun>(compiled.sql, compiled.params)
  notifyStoppedPolicyRuns(executor, rows)
  return rows.filter(row => row.stopped).length
}
