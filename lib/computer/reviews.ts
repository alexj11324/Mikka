import 'server-only'
import type { Pool } from 'pg'
import { checkedLocalReview } from '@/lib/cua/local-review'
import type { LocalComputerRequest } from '@mikka/protocol/computer'

/** Sync only snapshots from an owned device's live runs. The server never
 * supplies operation arguments back to the daemon: it returns a decision for
 * the exact digest the daemon generated. */
export async function syncComputerReviews(pool: Pool, deviceId: string, userId: string, snapshots: LocalComputerRequest[]) {
  const now = Date.now()
  const rows = snapshots.map(row => checkedLocalReview(row, now))
  if (rows.length > 20 || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Invalid snapshot')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const device = (await client.query('SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 FOR UPDATE', [deviceId, userId])).rows[0]
    if (!device) throw new Error('Device unavailable')
    for (const row of rows) {
      const run = (await client.query(`SELECT r.id,b."botId",d.display FROM agent_runs r
        LEFT JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
        LEFT JOIN bot_desktops d ON d."botId"=b."botId" AND d."ownerId"=b."ownerId" AND d."workspaceId"=b."workspaceId"
        WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3 AND r."stopRequestedAt" IS NULL
          AND r.status=ANY($4::text[]) FOR UPDATE OF r`, [row.runId, userId, deviceId, ['running', 'preparing', 'waiting_input', 'finishing']])).rows[0]
      if (!run || (run.botId ? row.display !== `:${run.display}` : row.display !== undefined)) throw new Error('Run or desktop unavailable')
      const inserted = await client.query(`INSERT INTO local_computer_reviews (id,"deviceId","runId","userId",target,display,call,digest,"expiresAt","seenAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT (id) DO UPDATE SET "seenAt"=now()
        WHERE local_computer_reviews."deviceId"=EXCLUDED."deviceId" AND local_computer_reviews."runId"=EXCLUDED."runId"
          AND local_computer_reviews."userId"=EXCLUDED."userId" AND local_computer_reviews.digest=EXCLUDED.digest RETURNING id`,
      [row.id, deviceId, row.runId, userId, row.target, row.display ?? null, JSON.stringify(row.call), row.digest, new Date(row.expiresAt)])
      if (!inserted.rowCount) throw new Error('Review changed')
    }
    await client.query('DELETE FROM local_computer_reviews WHERE "deviceId"=$1 AND "userId"=$2 AND NOT (id=ANY($3::uuid[]))', [deviceId, userId, rows.map(row => row.id)])
    const result = await client.query('SELECT id,digest,decision AS approve FROM local_computer_reviews WHERE "deviceId"=$1 AND "userId"=$2 AND id=ANY($3::uuid[]) AND decision IS NOT NULL AND "expiresAt">now() AND "seenAt">now()-interval \'10 seconds\'', [deviceId, userId, rows.map(row => row.id)])
    await client.query('COMMIT')
    return result.rows
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** One owner/workspace-scoped decision; duplicate, stale and changed digests
 * never succeed. This only queues a decision, not a claim of execution. */
export async function decideComputerReview(pool: Pool, actor: { userId: string; workspaceId: string }, id: string, digest: string, approve: boolean) {
  const result = await pool.query(`UPDATE local_computer_reviews v SET decision=$5
    FROM agent_runs r, computer_run_bindings b, devices dev
    WHERE v.id=$1 AND v.digest=$2 AND v."userId"=$3 AND v.decision IS NULL AND v."expiresAt">now()
      AND v."seenAt">now()-interval '10 seconds' AND r.id=v."runId" AND r."userId"=$3
      AND r."deviceId"=v."deviceId" AND r."stopRequestedAt" IS NULL
      AND r.status=ANY($6::text[]) AND b."runId"=r.id AND b."ownerId"=$3 AND b."workspaceId"=$4
      AND dev.id=v."deviceId" AND dev."ownerId"=$3 RETURNING v.id`,
  [id, digest, actor.userId, actor.workspaceId, approve, ['running', 'preparing', 'waiting_input', 'finishing']])
  return result.rowCount === 1
}
