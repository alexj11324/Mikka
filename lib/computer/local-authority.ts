import 'server-only'
import type { Pool } from 'pg'
import type { RunAssignment } from '@mikka/protocol/device'

/** Read current authority from persisted ownership, never a task or model field.
 * A local run without a Bot has no proven workspace and receives no CUA grant. */
export async function localComputerAuthority(pool: Pool, ownerId: string, deviceId: string, runId: string): Promise<NonNullable<RunAssignment['localComputer']> | null> {
  const row = (await pool.query(`SELECT b.id AS "botId",b."ownerId",b."workspaceId",
      coalesce(p.permission,'ask') AS permission,coalesce(p.version,0) AS "policyVersion"
    FROM agent_runs r JOIN bots b ON b.id=r."botId" AND b."ownerId"=r."userId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d.kind='local' AND d.enabled=true
    LEFT JOIN workspace_computer_policies p ON p."workspaceId"=b."workspaceId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3
      AND r.status=ANY($4::text[]) AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()
      AND NOT EXISTS (SELECT 1 FROM computer_run_bindings crb WHERE crb."runId"=r.id)`,
  [runId, ownerId, deviceId, ['preparing', 'running', 'waiting_input', 'finishing']])).rows[0]
  if (!row || !['allow', 'ask'].includes(row.permission) || !Number.isSafeInteger(row.policyVersion) || row.policyVersion < 0) return null
  return { botId: row.botId, ownerId: row.ownerId, workspaceId: row.workspaceId, permission: row.permission, policyVersion: row.policyVersion }
}
