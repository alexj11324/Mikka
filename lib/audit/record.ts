// Settings › 审计日志 writer. Usage:
//   await recordAudit(tx, { workspaceId, actor: { type: 'user', id, name }, action: 'token.created', target: { type: 'token', id, label: name }, ...auditRequestContext(headers) })
// Pass the business transaction when the audited write lives in the MIKKA
// database, so the row commits or rolls back with it. Member/permission writes
// live in DATABASE_URL and cannot share a transaction: call recordAuditSafe
// after they commit; a failed audit write is logged, never surfaced.
// Secret, token and egress (network policy) events live in the MIKKA database
// and MUST use in-transaction recordAudit(tx, …), never recordAuditSafe.
// Retention: no TTL/cleanup job yet (pending Alex).
import 'server-only'
import { db as defaultDb } from '@/lib/db'
import { workspaceAuditEvents } from '@/lib/db/audit-schema'
import { toAuditRow, type AuditEvent } from './events'

export * from './events'

type Insertable = Pick<typeof defaultDb, 'insert'>

export type RecordedAudit = { id: string; createdAt: Date }

export async function recordAudit(executor: Insertable, event: AuditEvent): Promise<RecordedAudit> {
  const row = toAuditRow(event)
  const [saved] = await executor.insert(workspaceAuditEvents).values(row)
    .returning({ id: workspaceAuditEvents.id, createdAt: workspaceAuditEvents.createdAt })
  return saved
}

/** Best effort: never throws. Logs action and error only (no metadata, labels or ip). */
// TODO(audit): replace log-only failure with an outbox or retry; member/permission
// writes live in DATABASE_URL, so they cannot share the audit transaction.
export async function recordAuditSafe(executor: Insertable, event: AuditEvent): Promise<RecordedAudit | null> {
  try {
    return await recordAudit(executor, event)
  } catch (error) {
    console.error('[audit] write failed', { action: event?.action, workspaceId: event?.workspaceId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
