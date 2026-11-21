import 'server-only'
import type { PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { auditDatabases, connectAuditDatabases, requireAuditAdmin } from './database'
import { recordAudit } from './record'
import { armDueTimerSoon } from '@/lib/due-timer'

export const auditRetentionInput = z.object({ retentionDays: z.number().int().min(1).max(36500).nullable(), legalHold: z.boolean() }).strict()
export type AuditRetentionInput = z.infer<typeof auditRetentionInput>
interface Policy extends AuditRetentionInput { revision: number; updatedAt: Date | null }
const retained: Policy = { retentionDays: null, legalHold: false, revision: 0, updatedAt: null }

export async function readAuditRetention(actorId: string, workspaceId: string, database = auditDatabases()): Promise<Policy> {
  const ws = await database.workspace.connect()
  try {
    await ws.query('BEGIN'); await requireAuditAdmin(ws, actorId, workspaceId)
    const policy = (await database.main.query<Policy>('SELECT "retentionDays","legalHold",revision,"updatedAt" FROM workspace_audit_retention WHERE "workspaceId"=$1', [workspaceId])).rows[0] ?? retained
    await ws.query('COMMIT'); return policy
  } catch (error) { await ws.query('ROLLBACK'); throw error } finally { ws.release() }
}
/** An explicit admin choice, never a default retention policy. Configuration and its audit share the main transaction. */
export async function configureAuditRetention(actorId: string, workspaceId: string, input: AuditRetentionInput, database = auditDatabases()): Promise<Policy> {
  const value = auditRetentionInput.parse(input)
  const { ws, app } = await connectAuditDatabases(database)
  try {
    await ws.query('BEGIN'); const actor = await requireAuditAdmin(ws, actorId, workspaceId)
    await app.query('BEGIN')
    const policy = (await app.query<Policy>(`INSERT INTO workspace_audit_retention("workspaceId","retentionDays","legalHold","configuredBy") VALUES($1,$2,$3,$4)
      ON CONFLICT("workspaceId") DO UPDATE SET "retentionDays"=excluded."retentionDays","legalHold"=excluded."legalHold","configuredBy"=excluded."configuredBy",revision=workspace_audit_retention.revision+1,"updatedAt"=now()
      RETURNING "retentionDays","legalHold",revision,"updatedAt"`, [workspaceId, value.retentionDays, value.legalHold, actorId])).rows[0]
    await recordAudit(drizzle(app), { workspaceId, actor: { type: 'user', id: actorId, name: actor.name }, action: 'audit.retention_changed', metadata: value })
    await app.query('COMMIT'); await ws.query('COMMIT')
    // A new period can make events due now (#1371).
    armDueTimerSoon('audit-retention')
    return policy
  } catch (error) { await Promise.allSettled([app.query('ROLLBACK'), ws.query('ROLLBACK')]); throw error }
  finally { app.release(); ws.release() }
}

/**
 * A deleted workspace's audit events stay until this many days after its
 * deletion (workspace_deletions, recorded by lib/workspace-rows.ts), then go,
 * however old they were at deletion (decision 2026-11-02-0231). A retention
 * period chosen before deletion applies on top: whichever keeps an event
 * longer wins. A legal hold still holds. A NULL retention period counts as
 * none chosen. A workspace that is not deleted is unaffected.
 */
export const DELETED_WORKSPACE_RETENTION_DAYS = 90

/** Explicitly configured event expiry, and a deleted workspace's expiry. Active export receipts and a legal hold block deletion. */
export async function applyAuditRetention(workspaceId: string, now = new Date(), database = auditDatabases()) {
  const { ws, app } = await connectAuditDatabases(database)
  try {
    await ws.query('BEGIN')
    // Export creation holds the shared version of this lock until its separate receipt commits.
    await ws.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mikka-audit-retention:${workspaceId}`])
    await app.query('BEGIN')
    const policy = (await app.query<Policy>('SELECT "retentionDays","legalHold",revision,"updatedAt" FROM workspace_audit_retention WHERE "workspaceId"=$1 FOR UPDATE', [workspaceId])).rows[0]
    const deletion = (await app.query<{ deletedAt: Date }>('SELECT "deletedAt" FROM workspace_deletions WHERE id=$1 FOR UPDATE', [workspaceId])).rows[0]
    if (deletion) {
      const result = await expireDeletedWorkspace(app, ws, workspaceId, policy ?? retained, deletion.deletedAt, now)
      await app.query('COMMIT'); await ws.query('COMMIT'); return result
    }
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
/** In applyAuditRetention's transactions. Nothing is logged into a deleted workspace: nobody can read it. Its policy and deletion record go with its last event. */
async function expireDeletedWorkspace(app: PoolClient, ws: PoolClient, workspaceId: string, policy: Policy, deletedAt: Date, now: Date) {
  if (policy.legalHold) return { deleted: 0, skipped: 'legal_hold' as const }
  if (now.getTime() < deletedAt.getTime() + DELETED_WORKSPACE_RETENTION_DAYS * 86_400_000) return { deleted: 0, skipped: 'deleted_workspace_grace' as const }
  if ((await ws.query('SELECT 1 FROM workspace_audit_exports WHERE "workspaceId"=$1 AND "expiresAt">$2 LIMIT 1', [workspaceId, now])).rowCount) return { deleted: 0, skipped: 'active_export' as const }
  const removed = policy.retentionDays === null
    ? await app.query('DELETE FROM workspace_audit_events WHERE "workspaceId"=$1', [workspaceId])
    : await app.query('DELETE FROM workspace_audit_events WHERE "workspaceId"=$1 AND "createdAt"<$2', [workspaceId, new Date(now.getTime() - policy.retentionDays * 86_400_000)])
  if (!(await app.query('SELECT 1 FROM workspace_audit_events WHERE "workspaceId"=$1 LIMIT 1', [workspaceId])).rowCount) {
    await app.query('DELETE FROM workspace_audit_retention WHERE "workspaceId"=$1', [workspaceId])
    await app.query('DELETE FROM workspace_deletions WHERE id=$1', [workspaceId])
  }
  return { deleted: removed.rowCount ?? 0, skipped: null }
}

export async function sweepAuditRetention(database = auditDatabases()) {
  const policies = (await database.main.query<{ workspaceId: string }>(`SELECT "workspaceId" FROM workspace_audit_retention WHERE "retentionDays" IS NOT NULL AND "legalHold"=false
    UNION SELECT d.id FROM workspace_deletions d WHERE NOT EXISTS (SELECT 1 FROM workspace_audit_retention p WHERE p."workspaceId"=d.id AND p."legalHold") ORDER BY 1`)).rows
  let deleted = 0, pending = 0
  for (const policy of policies) {
    try { deleted += (await applyAuditRetention(policy.workspaceId, new Date(), database)).deleted }
    catch { pending++ }
  }
  return { scanned: policies.length, deleted, pending }
}
