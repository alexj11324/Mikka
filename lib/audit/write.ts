// Shared transaction-bound audit writer for the app and isolated services.
// The caller owns the connection/transaction; no app database or environment
// singleton may be imported across this runtime boundary.
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { workspaceAuditEvents } from '../db/audit-schema'
import { toAuditRow, type AuditEvent } from './events'

type Insertable = Pick<NodePgDatabase, 'insert'>
export type RecordedAudit = { id: string; createdAt: Date }

export async function recordAudit(executor: Insertable, event: AuditEvent): Promise<RecordedAudit> {
  const row = toAuditRow(event)
  const [saved] = await executor.insert(workspaceAuditEvents).values(row)
    .returning({ id: workspaceAuditEvents.id, createdAt: workspaceAuditEvents.createdAt })
  return saved
}
