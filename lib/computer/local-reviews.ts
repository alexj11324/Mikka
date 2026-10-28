import 'server-only'
import type { Pool } from 'pg'

/** Local-device reviews only. The display and cloud binding must both be
 * absent; this endpoint cannot authorize a cloud desktop. */
export async function pendingLocalComputerReviews(pool: Pool, userId: string) {
  return (await pool.query(`SELECT v.id,v."runId",v.target,v.call,v.digest,v."expiresAt",d.name AS device
    FROM local_computer_reviews v JOIN devices d ON d.id=v."deviceId" AND d."ownerId"=v."userId"
    JOIN agent_runs r ON r.id=v."runId" AND r."deviceId"=d.id AND r."userId"=v."userId"
    WHERE v."userId"=$1 AND d.kind='local' AND d.enabled=true AND v.display IS NULL
      AND NOT EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id)
      AND v.decision IS NULL AND v."expiresAt">now() AND v."seenAt">now()-interval '10 seconds'
      AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()
      AND r.status=ANY($2::text[]) ORDER BY v."seenAt" LIMIT 20`,
  [userId, ['running', 'preparing', 'waiting_input', 'finishing']])).rows
}

/** A decision queues exactly the displayed digest; it is not an execution
 * receipt. Lock the run to serialize with cancellation and snapshot sync. */
export async function decideLocalComputerReview(pool: Pool, userId: string, id: string, digest: string, approve: boolean) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const found = await client.query(`SELECT v.id FROM local_computer_reviews v
      JOIN devices d ON d.id=v."deviceId" AND d."ownerId"=v."userId"
      JOIN agent_runs r ON r.id=v."runId" AND r."deviceId"=d.id AND r."userId"=v."userId"
      WHERE v.id=$1 AND v.digest=$2 AND v."userId"=$3 AND d.kind='local' AND d.enabled=true
        AND v.display IS NULL AND NOT EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id)
        AND v.decision IS NULL AND v."expiresAt">now() AND v."seenAt">now()-interval '10 seconds'
        AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now() AND r.status=ANY($4::text[])
      FOR UPDATE OF r,d,v`, [id, digest, userId, ['running', 'preparing', 'waiting_input', 'finishing']])
    if (!found.rowCount) { await client.query('COMMIT'); return false }
    const result = await client.query('UPDATE local_computer_reviews SET decision=$2 WHERE id=$1 AND decision IS NULL RETURNING id', [id, approve])
    await client.query('COMMIT')
    return result.rowCount === 1
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
