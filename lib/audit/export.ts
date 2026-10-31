import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { WorkspaceError } from '@/lib/workspace-access'
import { AUDIT_WINDOW_DAYS } from './cursor'
import { recordAudit } from './record'
import { auditDigest, auditExportRecords, type AuditExportManifest, type AuditExportRecord } from './integrity'
import type { AuditEventView } from './query'

const EXPORT_TTL_MS = 15 * 60_000
export const AUDIT_EXPORT_MAX = 50_000
export class AuditExportError extends Error {
  constructor(readonly code: 'auditExportLimitExceeded' | 'auditExportUnavailable' | 'auditExportChanged', readonly status: number) { super(code); this.name = 'AuditExportError' }
}
type ExportEvent = AuditEventView & { actorId: string | null; targetId: string | null; createdAtMicros: string }
type RawEvent = Omit<ExportEvent, 'createdAt'> & { createdAt: Date }
type Targets = { main: Pool; workspace: Pool }
const targets = (): Targets => ({ main: pool, workspace: workspacePool })
const columns = `id, "createdAt", (extract(epoch from "createdAt")*1000000)::bigint::text AS "createdAtMicros",
 "actorType", "actorId", "actorName", action, category, "targetType", "targetId", "targetLabel", metadata,
 host(ip) AS ip, "geoCity"`
const view = (row: RawEvent): ExportEvent => ({ ...row, createdAt: row.createdAt.toISOString() })

async function admin(tx: PoolClient, actorId: string, workspaceId: string) {
  const row = (await tx.query<{ name: string }>(`SELECT m.name FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id
    WHERE w.id=$1 AND m."userId"=$2 AND m.status='active' AND m.role='admin' FOR SHARE OF w,m`, [workspaceId, actorId])).rows[0]
  if (!row) throw new WorkspaceError('workspaceAccessDenied')
  return row
}

/** A stable, bounded snapshot. Oversized exports fail explicitly instead of returning a partial CSV. */
export async function createAuditExport(actorId: string, workspaceId: string, filter: 'all' | 'security', now = new Date(), cap = AUDIT_EXPORT_MAX, database = targets()) {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > AUDIT_EXPORT_MAX) throw new RangeError('Invalid audit export limit')
  const ws = await database.workspace.connect(), app = await database.main.connect()
  try {
    await ws.query('BEGIN')
    const actor = await admin(ws, actorId, workspaceId)
    await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const from = new Date(now.getTime() - AUDIT_WINDOW_DAYS * 86_400_000)
    const selected = (await app.query<RawEvent>(`SELECT ${columns} FROM workspace_audit_events
      WHERE "workspaceId"=$1 AND "createdAt">$2 AND "createdAt"<=$3 AND ($4='all' OR category='security')
      ORDER BY "createdAt" DESC,id DESC LIMIT $5`, [workspaceId, from, now, filter, cap + 1])).rows
    if (selected.length > cap) throw new AuditExportError('auditExportLimitExceeded', 413)
    const events = selected.map(view), records = auditExportRecords(events)
    const manifest: AuditExportManifest = { format: 'mikka-audit-export', version: 1, id: randomUUID(), workspaceId,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + EXPORT_TTL_MS).toISOString(), from: from.toISOString(), until: now.toISOString(),
      filter, count: events.length, digest: auditDigest(records) }
    await recordAudit(drizzle(app), { workspaceId, actor: { type: 'user', id: actorId, name: actor.name }, action: 'audit.exported',
      target: { type: 'audit_export', id: manifest.id }, metadata: { count: manifest.count, digest: manifest.digest } })
    await app.query('COMMIT')
    // The anchor is in the workspace database, independent of the event rows.
    // A failure here returns no export; the already-recorded preparation event remains truthful.
    await ws.query(`INSERT INTO workspace_audit_exports(id,"workspaceId","createdBy",manifest,records,"expiresAt") VALUES($1,$2,$3,$4,$5,$6)`,
      [manifest.id, workspaceId, actorId, manifest, JSON.stringify(records), manifest.expiresAt])
    await ws.query('COMMIT')
    return { manifest, events }
  } catch (error) {
    await Promise.allSettled([app.query('ROLLBACK'), ws.query('ROLLBACK')])
    throw error
  } finally { app.release(); ws.release() }
}

/** Resume an export by its immutable ID; every page rechecks admin authority and row digests. */
export async function readAuditExportPage(actorId: string, workspaceId: string, exportId: string, offset = 0, limit = 100, now = new Date(), database = targets()) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid audit page')
  const ws = await database.workspace.connect()
  try {
    await ws.query('BEGIN')
    await admin(ws, actorId, workspaceId)
    const saved = (await ws.query<{ manifest: AuditExportManifest; records: AuditExportRecord[] }>(`SELECT manifest,records FROM workspace_audit_exports WHERE id=$1 AND "workspaceId"=$2 AND "expiresAt">$3`, [exportId, workspaceId, now])).rows[0]
    if (!saved) throw new AuditExportError('auditExportUnavailable', 404)
    if (saved.records.length !== saved.manifest.count || auditDigest(saved.records) !== saved.manifest.digest) throw new AuditExportError('auditExportChanged', 409)
    const expected = saved.records.slice(offset, offset + limit)
    const rows = expected.length ? (await database.main.query<RawEvent>(`SELECT ${columns} FROM workspace_audit_events WHERE "workspaceId"=$1 AND id=ANY($2::uuid[])`, [workspaceId, expected.map(row => row.id)])).rows : []
    const byId = new Map(rows.map(row => [row.id, view(row)]))
    const events = expected.map(item => byId.get(item.id))
    if (events.some((event, i) => !event || auditDigest(event) !== expected[i].digest)) throw new AuditExportError('auditExportChanged', 409)
    await ws.query('COMMIT')
    return { manifest: saved.manifest, events: events as ExportEvent[], nextOffset: offset + expected.length < saved.manifest.count ? offset + expected.length : null }
  } catch (error) { await ws.query('ROLLBACK'); throw error } finally { ws.release() }
}
