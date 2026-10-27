import 'server-only'
import type { Pool } from 'pg'

/** A cloud token is valid only while its exact owned machine still exists.
 * A thread credential additionally expires with that thread's lifecycle. */
export async function cloudDeviceIsActive(pool: Pool, deviceId: string, workspaceId: string, userId: string) {
  const result = await pool.query(`SELECT 1 FROM cloud_machines m JOIN devices d ON d.id=m."deviceId"
    WHERE m."deviceId"=$1 AND m."workspaceId"=$2 AND m."ownerId"=$3 AND d."ownerId"=$3 AND d.kind='cloud'
    UNION ALL
    SELECT 1 FROM thread_machines t JOIN devices d ON d.id=t."deviceId"
    JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId"
    WHERE t."deviceId"=$1 AND t."workspaceId"=$2 AND t."ownerId"=$3 AND d."ownerId"=$3 AND d.kind='cloud'
      AND t.state IN ('starting','running','paused') AND r.status IN ('queued','preparing','running','waiting_input','finishing')`,
  [deviceId, workspaceId, userId])
  return Boolean(result.rowCount)
}
