import 'server-only'
import type { Pool } from 'pg'
import { ComputerError } from '@/lib/computer/store'
import type { Actor } from './subagents'

/** Host-owned fields from #161's claimed assignment, never model input. This
 * is a binding, not an action grant: the broker must still consume permission. */
export type ClaimedComputer = { runId: string; deviceId: string; botId: string; ownerId: string; display: string; policyVersion: number }
export async function bindSubagentRun(pool: Pool, actor: Actor, subagentId: string, claimed: ClaimedComputer) {
  const { botId, runId } = claimed
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    const row = (await client.query(`SELECT r.id AS "runId",r."deviceId",d.display,p.permission,p.version
      FROM bot_subagents s
      JOIN computer_run_bindings b ON b."botId"=s."botId" AND b."ownerId"=s."ownerId" AND b."workspaceId"=s."workspaceId" AND b."runId"=$5
      JOIN agent_runs r ON r.id=b."runId" AND r."userId"=s."ownerId" AND r."deviceId" IS NOT NULL
      JOIN cloud_machines m ON m."workspaceId"=s."workspaceId" AND m."ownerId"=s."ownerId" AND m."deviceId"=r."deviceId" AND m.state='running'
      JOIN devices dev ON dev.id=r."deviceId" AND dev."ownerId"=s."ownerId" AND dev.kind='cloud' AND dev.enabled=true
      JOIN bot_desktops d ON d."botId"=s."botId" AND d."workspaceId"=s."workspaceId" AND d."ownerId"=s."ownerId"
      JOIN byos_native_runs n ON n."runId"=r.id
      JOIN byos_bindings sub ON sub.id=n."bindingId" AND sub."ownerId"=s."ownerId" AND sub."workspaceId"=s."workspaceId"::text AND sub."consumerId"=r."agentId"::text
      JOIN byos_connections c ON c.id=sub."connectionId" AND c."ownerId"=sub."ownerId" AND c."workspaceId"=sub."workspaceId" AND c.state='connected' AND c.epoch=sub."connectionRevision"
      LEFT JOIN workspace_computer_policies p ON p."workspaceId"=s."workspaceId"
      WHERE s.id=$1 AND s."ownerId"=$2 AND s."workspaceId"=$3 AND s."botId"=$4 AND s.status IN ('running','needs_you')
        AND r.status IN ('preparing','running') AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">clock_timestamp()
      FOR UPDATE OF s,r`, [subagentId, actor.userId, actor.workspaceId, botId, runId])).rows[0]
    if (!row || !['ask', 'allow'].includes(row.permission ?? 'ask') || !Number.isSafeInteger(Number(row.version ?? 0)) || Number(row.version ?? 0) < 0 || !Number.isSafeInteger(Number(row.display)) || Number(row.display) < 1 || claimed.ownerId !== actor.userId || claimed.deviceId !== row.deviceId || claimed.display !== `:${row.display}` || claimed.policyVersion !== Number(row.version ?? 0)) throw new ComputerError(403, 'Claimed computer run unavailable')
    const existing = (await client.query('SELECT "runId","ownerId","workspaceId","botId" FROM subagent_run_bindings WHERE "subagentId"=$1 FOR UPDATE', [subagentId])).rows[0]
    if (existing && (existing.runId !== runId || existing.ownerId !== actor.userId || existing.workspaceId !== actor.workspaceId || existing.botId !== botId)) throw new ComputerError(409, 'Subagent run binding changed')
    if (!existing) {
      const owner = (await client.query('SELECT "subagentId" FROM subagent_run_bindings WHERE "runId"=$1 FOR UPDATE', [runId])).rows[0]
      if (owner) throw new ComputerError(409, 'Computer run already bound')
      await client.query('INSERT INTO subagent_run_bindings ("subagentId","runId","ownerId","workspaceId","botId") VALUES ($1,$2,$3,$4,$5)', [subagentId, runId, actor.userId, actor.workspaceId, botId])
    }
    await client.query('COMMIT')
    return { runId, deviceId: row.deviceId as string, display: `:${row.display}`, policyVersion: Number(row.version ?? 0), permission: (row.permission ?? 'ask') as 'ask' | 'allow' }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
