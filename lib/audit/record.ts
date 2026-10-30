// Settings › 审计日志 writer. Usage:
//   await recordAudit(tx, { workspaceId, actor: { type: 'user', id, name }, action: 'token.created', target: { type: 'token', id, label: name }, ...auditRequestContext(headers) })
// Rules:
// - Writes that live in the MIKKA database (secret, token, egress/network policy)
//   MUST call recordAudit(tx, …) inside the business transaction, so the audit
//   row commits or rolls back with the change. Never use recordAuditSafe for them.
// - Only cross-database member/permission writes (DATABASE_URL, which cannot share
//   a transaction with MIKKA_DATABASE_URL) use recordAuditSafe, after they commit.
// - Retention: no TTL/cleanup job yet (pending Alex).
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

/**
 * What may be logged about a failed audit write: the error class, the Postgres
 * SQLSTATE and the constraint name. Never error.message: drizzle's
 * DrizzleQueryError message is "Failed query: … params: …" and would leak
 * metadata, labels and ip.
 */
export function auditFailureSummary(error: unknown): { name: string; code: string | null; constraint: string | null } {
  const raw = error instanceof Error ? (error.name !== 'Error' ? error.name : error.constructor?.name || error.name) : typeof error
  const name = /^[A-Za-z0-9_$]{1,63}$/.test(raw) ? raw : 'Error'
  const cause = (error as { cause?: unknown } | null)?.cause ?? error
  const pick = (key: 'code' | 'constraint') => {
    const value = (cause as Record<string, unknown> | null)?.[key]
    return typeof value === 'string' && /^[A-Za-z0-9_]{1,63}$/.test(value) ? value : null
  }
  return { name, code: pick('code'), constraint: pick('constraint') }
}

/**
 * Best effort, root database only: never throws, and never takes a transaction.
 * A swallowed insert error inside a caller's transaction would abort it and turn
 * its COMMIT into a silent ROLLBACK, so this always writes on its own connection.
 * Logs only action, workspaceId and auditFailureSummary.
 */
// TODO(audit): replace log-only failure with an outbox or retry; member/permission
// writes live in DATABASE_URL, so they cannot share the audit transaction.
export async function recordAuditSafe(event: AuditEvent): Promise<RecordedAudit | null> {
  try {
    return await recordAudit(defaultDb, event)
  } catch (error) {
    console.error('[audit] write failed', { action: event?.action, workspaceId: event?.workspaceId, ...auditFailureSummary(error) })
    return null
  }
}
