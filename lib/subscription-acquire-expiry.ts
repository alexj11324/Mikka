import type { Pool } from 'pg'

// These are reservations that have never acquired an account. Every credential
// reference (including staging) and every binding is evidence to preserve it.
const EMPTY_CONNECTION_SQL = `c."providerSubject" IS NULL AND c."accountLabel" IS NULL
  AND c."secretName" IS NULL AND c."secretDigest" IS NULL
  AND c."accessSecretName" IS NULL AND c."accessDigest" IS NULL
  AND c."stagedSecretName" IS NULL AND c."stagedDigest" IS NULL
  AND c."stagedAccessName" IS NULL AND c."stagedAccessDigest" IS NULL
  AND NOT EXISTS (SELECT 1 FROM byos_bindings binding WHERE binding."connectionId"=c.id)`

const EXPIRABLE_CONNECTION_SQL = `c."removedAt" IS NULL AND (
    (c.state='pending' AND c."operationKind"='acquire' AND c."operationDeadline"<now())
    OR (c.state IN ('pending','reconnect_required','disconnected') AND (${EMPTY_CONNECTION_SQL})
      AND (c."operationDeadline" IS NULL OR c."operationDeadline"<now())
      AND (c."updatedAt"<now()-interval '1 hour' OR EXISTS (
        SELECT 1 FROM byos_connections connected WHERE connected."ownerId"=c."ownerId"
          AND connected.provider=c.provider
          AND connected.state='connected' AND connected."removedAt" IS NULL
          AND connected."updatedAt">c."updatedAt"))))
  AND NOT EXISTS (SELECT 1 FROM byos_oauth_attempts attempt WHERE attempt."connectionId"=c.id
    AND attempt."consumedAt" IS NULL AND attempt."expiresAt">now())
  AND NOT EXISTS (SELECT 1 FROM byos_enrollment_transfers transfer
    WHERE transfer."connectionId"=c.id AND transfer.epoch=c.epoch AND transfer."operationId"=c."operationId")`

/** Expire abandoned OAuth sign-ins, preserving durable enrollment escrow and publications. */
export async function expireSubscriptionAcquisitions(pool: Pick<Pool, 'query'>, ownerId?: string): Promise<{ expired: number; ownerIds: string[] }> {
  const { rows } = await pool.query<{ ownerId: string }>(`
    WITH candidates AS (
      SELECT c.id,c."ownerId",c."workspaceId",c.epoch,c."operationId",(${EMPTY_CONNECTION_SQL}) AS empty
      FROM byos_connections c
      WHERE ${EXPIRABLE_CONNECTION_SQL}
        AND ($1::text IS NULL OR c."ownerId"=$1)
      ORDER BY c."operationDeadline",c.id
      LIMIT 100 FOR UPDATE SKIP LOCKED
    ), expired AS (
      UPDATE byos_connections c SET state=CASE WHEN old.empty THEN 'disconnected' ELSE 'reconnect_required' END,epoch=c.epoch+1,
        "removedAt"=CASE WHEN old.empty THEN now() ELSE c."removedAt" END,
        "operationId"=NULL,"operationKind"=NULL,"operationDeadline"=NULL,
        "stagedSecretName"=NULL,"stagedDigest"=NULL,"stagedAccessName"=NULL,"stagedAccessDigest"=NULL,
        "lastErrorCode"='acquire_expired',"updatedAt"=now()
      FROM candidates old
      WHERE c.id=old.id AND c.epoch=old.epoch AND c."operationId" IS NOT DISTINCT FROM old."operationId"
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

/** Secret artifacts and enrollment sources the cleanup worker still has to delete (connectionId, last attempt). */
export const CLEANUP_DUE_SQL = `select a."connectionId",a."deletingAt" as attempted from byos_secret_artifacts a join byos_connections c on c.id=a."connectionId" where a."deletedAt" is null and (a."publishedAt" is not null or a."notBefore"<=now()) and a.name not in (coalesce(c."secretName",''),coalesce(c."accessSecretName",''),coalesce(c."stagedSecretName",''),coalesce(c."stagedAccessName",'')) union all select a."connectionId",a."lastAttemptAt" from byos_enrollment_sources a join byos_enrollment_transfers t on t."enrollmentId"=a."enrollmentId" join byos_connections c on c.id=a."connectionId" where a."deletedAt" is null and (t."canonicalPublishedAt" is not null or t."boundAt" is not null or c.epoch>t.epoch)`

/** One statement: whether the hourly cleanup has anything to do (#1371): an abandoned sign-in that
 * expireSubscriptionAcquisitions would expire, or an artifact still to delete. An idle hour costs only this. */
export async function subscriptionCleanupDue(pool: Pick<Pool, 'query'>): Promise<boolean> {
  const { rows } = await pool.query<{ due: boolean }>(`SELECT EXISTS (SELECT 1 FROM byos_connections c WHERE ${EXPIRABLE_CONNECTION_SQL})
    OR EXISTS (${CLEANUP_DUE_SQL}) AS due`)
  return Boolean(rows[0]?.due)
}
