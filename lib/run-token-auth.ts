import { createHash } from 'node:crypto'
import type { Pool } from 'pg'

/** Shared worker authentication, independently testable without a model/runtime. */
export async function verifiedWorkerToken(pool: Pool, token: string | undefined) {
  if (!token?.startsWith('mkw_')) return null
  const hash = createHash('sha256').update(token).digest('hex')
  const { rows: [row] } = await pool.query<{ runId: string; userId: string; issueId: string | null; expiresAt: Date }>(`
    select t."runId",t."userId",r."issueId",t."expiresAt"
    from run_tokens t join agent_runs r on r.id=t."runId"
    join devices d on d.id=r."deviceId" and d."ownerId"=r."userId"
    where t."tokenHash"=$1 and t."revokedAt" is null and t."expiresAt">now()
      and r."userId"=t."userId" and r.status in ('queued','preparing','running','waiting_input','finishing')
      and r."stopRequestedAt" is null and d.enabled
    limit 1`, [hash])
  return row ?? null
}
