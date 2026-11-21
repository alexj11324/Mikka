import type { Pool } from 'pg'

/** Mirrors DELETED_WORKSPACE_RETENTION_DAYS in lib/audit/retention.ts (kept import-free for this query). */
const DELETED_WORKSPACE_RETENTION_DAYS = 90

/**
 * Each persisted due time of audit retention on the main database, as rows of `at` (#1371),
 * matching the elapsed 24-hour periods used by applyAuditRetention, even across DST:
 * - a workspace with a retention period and no legal hold: in the hour after its oldest event
 *   passes the period (events never wait more than an hour past it, the cadence the cron had);
 * - a deleted workspace: when its 90-day grace ends, or, with a longer retention period, when
 *   its oldest event passes that period.
 * The oldest event is read from workspace_audit_events_ws_created_idx.
 */
export const AUDIT_RETENTION_DUE_SQL = `SELECT date_trunc('hour', e.oldest + (p."retentionDays" * interval '24 hours'), 'UTC') + interval '1 hour' AS at
    FROM workspace_audit_retention p CROSS JOIN LATERAL (SELECT min("createdAt") AS oldest FROM workspace_audit_events WHERE "workspaceId" = p."workspaceId") e
    WHERE p."retentionDays" IS NOT NULL AND NOT p."legalHold" AND e.oldest IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_deletions d WHERE d.id = p."workspaceId")
  UNION ALL SELECT greatest(d."deletedAt" + (${DELETED_WORKSPACE_RETENTION_DAYS} * interval '24 hours'),
      CASE WHEN p."retentionDays" IS NULL THEN '-infinity'::timestamptz
        ELSE date_trunc('hour', e.oldest + (p."retentionDays" * interval '24 hours'), 'UTC') + interval '1 hour' END)
    FROM workspace_deletions d LEFT JOIN workspace_audit_retention p ON p."workspaceId" = d.id
    CROSS JOIN LATERAL (SELECT min("createdAt") AS oldest FROM workspace_audit_events WHERE "workspaceId" = d.id) e
    WHERE p."legalHold" IS NOT TRUE`

/** On the workspace database: an audit receipt not yet delivered to the main store is due at once. */
export const AUDIT_OUTBOX_DUE_SQL = `SELECT min(coalesce("lastAttemptAt", "createdAt")) AS at FROM workspace_audit_outbox WHERE "deliveredAt" IS NULL`

const epoch = (sql: string) => `SELECT ceil(extract(epoch FROM min(at))*1000)::bigint::text AS at FROM (${sql}) due`

/** The earliest audit work due (epoch ms), from both databases, or null. Two statements, one per database. */
export async function nextAuditRetentionDue(main: Pick<Pool, 'query'>, workspace: Pick<Pool, 'query'>): Promise<number | null> {
  const [retention, outbox] = await Promise.all([main.query<{ at: string | null }>(epoch(AUDIT_RETENTION_DUE_SQL)), workspace.query<{ at: string | null }>(epoch(AUDIT_OUTBOX_DUE_SQL))])
  const times = [retention.rows[0]?.at, outbox.rows[0]?.at].filter((at): at is string => at != null).map(Number)
  return times.length ? Math.min(...times) : null
}
