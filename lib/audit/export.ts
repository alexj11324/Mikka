import 'server-only'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { auditDatabases, connectAuditDatabases, requireAuditAdmin } from './database'
import { auditWindow, type AuditScope } from './cursor'
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
const columns = `id, "createdAt", (extract(epoch from "createdAt")*1000000)::bigint::text AS "createdAtMicros",
 "actorType", "actorId", "actorName", action, category, "targetType", "targetId", "targetLabel", metadata,
 host(ip) AS ip, "geoCity"`
const view = (row: RawEvent): ExportEvent => ({ ...row, createdAt: row.createdAt.toISOString() })


/** A stable, bounded snapshot. Oversized exports fail explicitly instead of returning a partial CSV. */
export async function createAuditExport(actorId: string, workspaceId: string, filter: 'all' | 'security', now = new Date(), cap = AUDIT_EXPORT_MAX, database = auditDatabases(), scope: Pick<AuditScope, 'categories' | 'from' | 'until'> = {}) {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > AUDIT_EXPORT_MAX) throw new RangeError('Invalid audit export limit')
  const { ws, app } = await connectAuditDatabases(database)
  try {
    await ws.query('BEGIN')
    await ws.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`mikka-audit-retention:${workspaceId}`])
    const actor = await requireAuditAdmin(ws, actorId, workspaceId)
    await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const { since: from, until } = auditWindow(scope, now)
    const selected = (await app.query<RawEvent>(`SELECT ${columns} FROM workspace_audit_events
      WHERE "workspaceId"=$1 AND "createdAt">$2 AND "createdAt"<=$3 AND ($4='all' OR category='security') AND ($6::text[] IS NULL OR category=ANY($6::text[]))
      ORDER BY "createdAt" DESC,id DESC LIMIT $5`, [workspaceId, from, until, filter, cap + 1, scope.categories ?? null])).rows
    if (selected.length > cap) throw new AuditExportError('auditExportLimitExceeded', 413)
    const events = selected.map(view), records = auditExportRecords(events)
    const manifest: AuditExportManifest = { format: 'mikka-audit-export', version: 1, id: randomUUID(), workspaceId,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + EXPORT_TTL_MS).toISOString(), from: from.toISOString(), until: until.toISOString(),
      filter, ...(scope.categories ? { categories: scope.categories } : {}), count: events.length, digest: auditDigest(records) }
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
export async function readAuditExportPage(actorId: string, workspaceId: string, exportId: string, offset = 0, limit = 100, now = new Date(), database = auditDatabases()) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid audit page')
  const ws = await database.workspace.connect()
  try {
    await ws.query('BEGIN')
    await requireAuditAdmin(ws, actorId, workspaceId)
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
