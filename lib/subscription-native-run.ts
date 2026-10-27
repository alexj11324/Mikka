import type { Pool } from 'pg'

/** A dedicated thread uses its own device while retaining the Bot's agent
 * and subscription. Verify the complete binding before accepting that device. */
export async function findNativeRun(pool: Pool, ownerId: string, deviceId: string, runId: string) {
  const { rows } = await pool.query(`SELECT b.id,b."workspaceId",b."consumerId",b.route
    FROM byos_native_runs n JOIN agent_runs r ON r.id=n."runId"
    JOIN agents a ON a.id=r."agentId" JOIN byos_bindings b ON b.id=n."bindingId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3 AND a."userId"=$2
      AND b."ownerId"=$2 AND b."consumerId"=a.id::text
      AND b.route=CASE a.harness WHEN 'codex' THEN 'codex_cli' WHEN 'claude_code' THEN 'claude_code_cli' ELSE '' END
      AND r.status IN ('preparing','running','waiting_input') AND r."leaseExpiresAt">now() AND r."stopRequestedAt" IS NULL
      AND (a."deviceId"=$3 OR EXISTS (
        SELECT 1 FROM thread_machines t
        JOIN computer_run_bindings c ON c."runId"=t."runId" AND c."ownerId"=t."ownerId" AND c."workspaceId"=t."workspaceId"
        JOIN bot_cloud_runtimes br ON br."botId"=c."botId" AND br."ownerId"=c."ownerId" AND br."workspaceId"=c."workspaceId" AND br."agentId"=a.id
        JOIN devices d ON d.id=t."deviceId" AND d."ownerId"=t."ownerId" AND d.kind='cloud' AND d.enabled=true
        WHERE t."runId"=r.id AND t."ownerId"=$2 AND t."deviceId"=$3 AND t.state='running'
          AND t."workspaceId"::text=b."workspaceId"))`, [runId, ownerId, deviceId])
  return rows[0] as { id: string; workspaceId: string; consumerId: string; route: string } | undefined
}
