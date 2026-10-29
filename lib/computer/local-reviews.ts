import 'server-only'
import type { Pool } from 'pg'
import { localComputerAuthority } from './local-authority'
import { checkedLocalReview } from '@/lib/cua/local-review'
import type { LocalComputerRequest } from '@mikka/protocol/computer'

/** Local snapshots keep their audit rows; disappearing requests expire without
 * deleting history. This route never addresses a cloud desktop. */
export async function syncLocalComputerReviews(pool: Pool, deviceId: string, userId: string, snapshots: LocalComputerRequest[]) {
  const rows = snapshots.map(row => checkedLocalReview(row, Date.now()))
  if (rows.length > 20 || new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => row.display !== undefined)) throw new Error('Invalid local snapshot')
  for (const row of rows) {
    if (!await localComputerAuthority(pool, userId, deviceId, row.runId)) throw new Error('Local authority unavailable')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const device = await client.query('SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind=$3 AND enabled=true FOR UPDATE', [deviceId, userId, 'local'])
    if (!device.rowCount) throw new Error('Local device unavailable')
    for (const row of rows) {
      const inserted = await client.query(`INSERT INTO local_computer_reviews (id,"deviceId","runId","userId",target,display,call,digest,"expiresAt","seenAt")
        VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,now()) ON CONFLICT (id) DO UPDATE SET "seenAt"=now()
        WHERE local_computer_reviews."deviceId"=EXCLUDED."deviceId" AND local_computer_reviews."runId"=EXCLUDED."runId"
          AND local_computer_reviews."userId"=EXCLUDED."userId" AND local_computer_reviews.digest=EXCLUDED.digest
          AND local_computer_reviews."seenAt">now()-interval '10 seconds' RETURNING id`,
      [row.id, deviceId, row.runId, userId, row.target, JSON.stringify(row.call), row.digest, new Date(row.expiresAt)])
      if (!inserted.rowCount) throw new Error('Local review changed or expired')
    }
    await client.query(`UPDATE local_computer_reviews SET "seenAt"='-infinity'::timestamptz
      WHERE "deviceId"=$1 AND "userId"=$2 AND display IS NULL AND NOT (id=ANY($3::uuid[]))`, [deviceId, userId, rows.map(row => row.id)])
    const result = await client.query(`SELECT id,digest,decision AS approve FROM local_computer_reviews WHERE "deviceId"=$1 AND "userId"=$2
      AND id=ANY($3::uuid[]) AND decision IS NOT NULL AND "expiresAt">now() AND "seenAt">now()-interval '10 seconds'`, [deviceId, userId, rows.map(row => row.id)])
    await client.query('COMMIT')
    return result.rows
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Local-device reviews only. The display and cloud binding must both be
 * absent; this endpoint cannot authorize a cloud desktop. */
export async function pendingLocalComputerReviews(pool: Pool, userId: string) {
  return (await pool.query(`SELECT v.id,v."runId",v.target,v.call,v.digest,v."expiresAt",d.name AS device
    FROM local_computer_reviews v JOIN devices d ON d.id=v."deviceId" AND d."ownerId"=v."userId"
    JOIN agent_runs r ON r.id=v."runId" AND r."deviceId"=d.id AND r."userId"=v."userId"
    JOIN bots bot ON bot.id=r."botId" AND bot."ownerId"=r."userId"
    LEFT JOIN workspace_computer_policies p ON p."workspaceId"=bot."workspaceId"
    WHERE v."userId"=$1 AND d.kind='local' AND d.enabled=true AND v.display IS NULL
      AND NOT EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id)
      AND coalesce(p.permission,'ask') IN ('allow','ask')
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
      JOIN bots bot ON bot.id=r."botId" AND bot."ownerId"=r."userId"
      LEFT JOIN workspace_computer_policies p ON p."workspaceId"=bot."workspaceId"
      WHERE v.id=$1 AND v.digest=$2 AND v."userId"=$3 AND d.kind='local' AND d.enabled=true
        AND v.display IS NULL AND NOT EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id)
        AND coalesce(p.permission,'ask') IN ('allow','ask')
        AND v.decision IS NULL AND v."expiresAt">now() AND v."seenAt">now()-interval '10 seconds'
        AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now() AND r.status=ANY($4::text[])
      FOR UPDATE OF r,d,v`, [id, digest, userId, ['running', 'preparing', 'waiting_input', 'finishing']])
    if (!found.rowCount) { await client.query('COMMIT'); return false }
    const result = await client.query('UPDATE local_computer_reviews SET decision=$2 WHERE id=$1 AND decision IS NULL RETURNING id', [id, approve])
    await client.query('COMMIT')
    return result.rowCount === 1
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
