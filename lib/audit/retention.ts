import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { WorkspaceError } from '@/lib/workspace-access'
import { recordAudit } from './record'

export const auditRetentionInput = z.object({ retentionDays: z.number().int().min(1).max(36500).nullable(), legalHold: z.boolean() }).strict()
export type AuditRetentionInput = z.infer<typeof auditRetentionInput>
type Targets = { main: Pool; workspace: Pool }
const targets = (): Targets => ({ main: pool, workspace: workspacePool })
interface Policy extends AuditRetentionInput { revision: number; updatedAt: Date | null }
const retained: Policy = { retentionDays: null, legalHold: false, revision: 0, updatedAt: null }
async function admin(tx: PoolClient, actorId: string, workspaceId: string) {
  const row = (await tx.query<{ name: string }>(`SELECT m.name FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id
    WHERE w.id=$1 AND m."userId"=$2 AND m.status='active' AND m.role='admin' FOR SHARE OF w,m`, [workspaceId, actorId])).rows[0]
  if (!row) throw new WorkspaceError('workspaceAccessDenied')
  return row
}
export async function readAuditRetention(actorId: string, workspaceId: string, database = targets()): Promise<Policy> {
  const ws = await database.workspace.connect()
  try {
    await ws.query('BEGIN'); await admin(ws, actorId, workspaceId)
    const policy = (await database.main.query<Policy>('SELECT "retentionDays","legalHold",revision,"updatedAt" FROM workspace_audit_retention WHERE "workspaceId"=$1', [workspaceId])).rows[0] ?? retained
    await ws.query('COMMIT'); return policy
  } catch (error) { await ws.query('ROLLBACK'); throw error } finally { ws.release() }
}
/** An explicit admin choice, never a default retention policy. Configuration and its audit share the main transaction. */
export async function configureAuditRetention(actorId: string, workspaceId: string, input: AuditRetentionInput, database = targets()): Promise<Policy> {
  const value = auditRetentionInput.parse(input), ws = await database.workspace.connect(), app = await database.main.connect()
  try {
    await ws.query('BEGIN'); const actor = await admin(ws, actorId, workspaceId)
    await app.query('BEGIN')
    const policy = (await app.query<Policy>(`INSERT INTO workspace_audit_retention("workspaceId","retentionDays","legalHold","configuredBy") VALUES($1,$2,$3,$4)
      ON CONFLICT("workspaceId") DO UPDATE SET "retentionDays"=excluded."retentionDays","legalHold"=excluded."legalHold","configuredBy"=excluded."configuredBy",revision=workspace_audit_retention.revision+1,"updatedAt"=now()
      RETURNING "retentionDays","legalHold",revision,"updatedAt"`, [workspaceId, value.retentionDays, value.legalHold, actorId])).rows[0]
    await recordAudit(drizzle(app), { workspaceId, actor: { type: 'user', id: actorId, name: actor.name }, action: 'audit.retention_changed', metadata: value })
    await app.query('COMMIT'); await ws.query('COMMIT'); return policy
  } catch (error) { await Promise.allSettled([app.query('ROLLBACK'), ws.query('ROLLBACK')]); throw error }
  finally { app.release(); ws.release() }
}

/** Explicitly configured event expiry. Active export receipts and a legal hold block deletion. */
export async function applyAuditRetention(workspaceId: string, now = new Date(), database = targets()) {
  const ws = await database.workspace.connect(), app = await database.main.connect()
  try {
    await ws.query('BEGIN')
    // Export creation holds the shared version of this lock until its separate receipt commits.
    await ws.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mikka-audit-retention:${workspaceId}`])
    await app.query('BEGIN')
    const policy = (await app.query<Policy>('SELECT "retentionDays","legalHold",revision,"updatedAt" FROM workspace_audit_retention WHERE "workspaceId"=$1 FOR UPDATE', [workspaceId])).rows[0]
    let skipped: 'retain' | 'legal_hold' | 'active_export' | null = !policy || policy.retentionDays === null ? 'retain' : policy.legalHold ? 'legal_hold' : null
    if (!skipped && (await ws.query('SELECT 1 FROM workspace_audit_exports WHERE "workspaceId"=$1 AND "expiresAt">$2 LIMIT 1', [workspaceId, now])).rowCount) skipped = 'active_export'
    if (skipped) { await app.query('COMMIT'); await ws.query('COMMIT'); return { deleted: 0, skipped } }
    const cutoff = new Date(now.getTime() - policy.retentionDays! * 86_400_000)
    const removed = await app.query('DELETE FROM workspace_audit_events WHERE "workspaceId"=$1 AND "createdAt"<$2', [workspaceId, cutoff])
    const deleted = removed.rowCount ?? 0
    if (deleted) await recordAudit(drizzle(app), { workspaceId, actor: { type: 'system' }, action: 'audit.retention_applied', metadata: { retentionDays: policy.retentionDays!, count: deleted } })
    await app.query('COMMIT'); await ws.query('COMMIT'); return { deleted, skipped: null }
  } catch (error) { await Promise.allSettled([app.query('ROLLBACK'), ws.query('ROLLBACK')]); throw error }
  finally { app.release(); ws.release() }
}
export async function sweepAuditRetention(database = targets()) {
  const policies = (await database.main.query<{ workspaceId: string }>('SELECT "workspaceId" FROM workspace_audit_retention WHERE "retentionDays" IS NOT NULL AND "legalHold"=false ORDER BY "workspaceId"')).rows
  let deleted = 0, pending = 0
  for (const policy of policies) {
    try { deleted += (await applyAuditRetention(policy.workspaceId, new Date(), database)).deleted }
    catch { pending++ }
  }
  return { scanned: policies.length, deleted, pending }
}
