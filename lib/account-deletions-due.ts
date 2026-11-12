import type { Pool } from 'pg'

// A frozen account's original deletion job owns these keys and their grant deadlines.
export function chatStorageCleanupOwner(table: 'chat_attachments' | 'chat_attachment_retirements') {
  return `NOT EXISTS (SELECT 1 FROM account_deletion_guards g
    JOIN account_deletion_jobs j ON j.id=g."jobId" AND j."subjectUserId"=g."subjectId"
    WHERE g."subjectId"=${table}."userId" AND j.stage NOT IN ('completed','cancelled'))`
}
const availableDraft = chatStorageCleanupOwner('chat_attachments')
const availableRetirement = chatStorageCleanupOwner('chat_attachment_retirements')

/**
 * Each persisted due time of account-deletion work, as rows of `at` (#1371), matching what
 * sweepAccountDeletions and cleanupChatFiles select:
 * - a deletion job: at once when nothing blocks it; at storageNotBefore while upload grants
 *   are still valid; an hour after its last try when a step failed or the person is a
 *   workspace's sole admin (the hourly recheck the cron had);
 * - an unused chat file: a day after upload, or once removed, after its upload grant expires;
 * - an upload grant still held: at its expiry; a retired object: at its notBefore.
 * Every term reads a partial index (account_deletion_pending_idx, chat_attachments_drafts_idx,
 * chat_attachments_upload_expiry_idx) or the small retirement queue.
 */
export const ACCOUNT_DELETIONS_DUE_SQL = `SELECT min(CASE WHEN "blockedReasons" @> '["upload_grants_not_expired"]' THEN "storageNotBefore"
      WHEN "blockedReasons" = '[]'::jsonb THEN "updatedAt" ELSE "updatedAt" + interval '1 hour' END) AS at
    FROM account_deletion_jobs WHERE stage NOT IN ('completed','cancelled')
  UNION ALL SELECT min(greatest(coalesce("removedAt", "createdAt" + interval '1 day' + interval '1 millisecond'),
      coalesce("uploadExpiresAt" + interval '1 millisecond', '-infinity'))) FROM chat_attachments WHERE "usedAt" IS NULL AND ${availableDraft}
  UNION ALL SELECT min("uploadExpiresAt") + interval '1 millisecond' FROM chat_attachments WHERE "uploadKey" IS NOT NULL AND ${availableDraft}
  UNION ALL SELECT min("notBefore") FROM chat_attachment_retirements WHERE ${availableRetirement}`

/** The earliest account-deletion work due (epoch ms, rounded up from PostgreSQL microseconds), or null. */
export async function nextAccountDeletionsDue(pool: Pick<Pool, 'query'>): Promise<number | null> {
  const { rows } = await pool.query<{ at: string | null }>(`SELECT ceil(extract(epoch FROM min(at))*1000)::bigint::text AS at FROM (${ACCOUNT_DELETIONS_DUE_SQL}) due`)
  return rows[0]?.at == null ? null : Number(rows[0].at)
}
