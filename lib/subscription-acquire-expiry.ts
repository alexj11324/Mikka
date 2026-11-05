import type { Pool } from 'pg'

/** Expire abandoned OAuth sign-ins, preserving durable enrollment escrow and publications. */
export async function expireSubscriptionAcquisitions(pool: Pick<Pool, 'query'>, ownerId?: string): Promise<{ expired: number; ownerIds: string[] }> {
  const { rows } = await pool.query<{ ownerId: string }>(`
    WITH candidates AS (
      SELECT c.id,c."ownerId",c."workspaceId",c.epoch,c."operationId"
      FROM byos_connections c
      WHERE c.state='pending' AND c."operationKind"='acquire' AND c."operationDeadline"<now()
        AND ($1::text IS NULL OR c."ownerId"=$1)
        AND NOT EXISTS (
          SELECT 1 FROM byos_enrollment_transfers transfer
          WHERE transfer."connectionId"=c.id AND transfer.epoch=c.epoch AND transfer."operationId"=c."operationId"
        )
      ORDER BY c."operationDeadline",c.id
      LIMIT 100 FOR UPDATE SKIP LOCKED
    ), expired AS (
      UPDATE byos_connections c SET state='reconnect_required',epoch=c.epoch+1,
        "operationId"=NULL,"operationKind"=NULL,"operationDeadline"=NULL,
        "stagedSecretName"=NULL,"stagedDigest"=NULL,"stagedAccessName"=NULL,"stagedAccessDigest"=NULL,
        "lastErrorCode"='acquire_expired',"updatedAt"=now()
      FROM candidates old
      WHERE c.id=old.id AND c.epoch=old.epoch AND c."operationId"=old."operationId"
      RETURNING c.id,c."ownerId",c."workspaceId",old."operationId"
    ), consumed AS (
      UPDATE byos_oauth_attempts attempt
      SET "consumedAt"=coalesce(attempt."consumedAt",now()),polling=false
      FROM expired
      WHERE attempt."connectionId"=expired.id AND attempt."operationId"=expired."operationId"
        AND attempt."ownerId"=expired."ownerId" AND attempt."workspaceId"=expired."workspaceId"
        AND (attempt."consumedAt" IS NULL OR attempt.polling)
    )
    SELECT "ownerId" FROM expired`, [ownerId ?? null])
  // Enrollment reserves its connection and transfer atomically. Its durable
  // escrow can resume after this deadline, so only a newer, explicit OAuth
  // operation on that connection may expire. Advancing the enrollment's epoch
  // would wrongly make its sole recovery copy eligible for source cleanup.
  // OAuth epoch fencing stops late exchanges; retain their artifact cleanup ledger.
  return { expired: rows.length, ownerIds: [...new Set(rows.map(row => row.ownerId))].sort() }
}
