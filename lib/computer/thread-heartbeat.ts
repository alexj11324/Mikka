import 'server-only'
import type { Pool } from 'pg'
import { renewComputerLifetime } from './e2b-provider'

/** The provider's timeout is absolute, not a measure of CPU activity. An
 * active, authenticated thread daemon extends it at most every two minutes.
 * If the daemon disappears, the machine still automatically pauses. */
export async function renewThreadLifetime(pool: Pool, deviceId: string, userId: string, runIds: readonly string[], renew = renewComputerLifetime) {
  if (!runIds.length) return
  const rows = (await pool.query<{ sandboxId: string }>(`UPDATE thread_machines t SET "lastActiveAt"=now()
    WHERE t."deviceId"=$1 AND t."ownerId"=$2 AND t."runId"=ANY($3::uuid[]) AND t.state='running'
      AND t."sandboxId" IS NOT NULL AND t."lastActiveAt"<now()-interval '2 minutes'
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=t."runId" AND r."userId"=t."ownerId"
        AND r."deviceId"=t."deviceId" AND r."stopRequestedAt" IS NULL
        AND r.status IN ('preparing','running','waiting_input','finishing') AND r."leaseExpiresAt">now())
    RETURNING t."sandboxId"`, [deviceId, userId, runIds])).rows
  for (const row of rows) await renew(row.sandboxId)
}
