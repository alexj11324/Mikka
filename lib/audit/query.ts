import 'server-only'
// 审计日志 read API (N6). Admin only, newest first, the last 90 days.
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { workspaceAuditEvents } from '@/lib/db/audit-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { auditPageInput, auditWindow, decodeAuditCursor, encodeAuditCursor } from './cursor'
import type { AuditActorType, AuditCategory } from './events'

export interface AuditEventView {
  id: string
  createdAt: string
  actorType: AuditActorType
  actorName: string
  action: string
  category: AuditCategory
  targetType: string | null
  targetLabel: string | null
  metadata: Record<string, unknown>
  /** Admins see the address and city, as N6 shows them. */
  ip: string | null
  geoCity: string | null
}

export interface AuditPage { events: AuditEventView[]; nextCursor: string | null }

const micros = sql<string>`(extract(epoch from ${workspaceAuditEvents.createdAt}) * 1000000)::bigint::text`

async function requireAdmin(actorId: string, workspaceId: string) {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId, true))
}

/**
 * One page. `filter: 'security'` is the 「安全」 segment; `categories`, `from`
 * and `until` narrow it further (auditPageInput). Errors: workspaceAccessDenied, validationGeneric.
 */
export async function listWorkspaceAudit(actorId: string, workspaceId: string, input: unknown, now = new Date()): Promise<AuditPage> {
  const { filter, categories, from, until: to, cursor, limit } = auditPageInput.parse(input ?? {})
  const position = cursor ? decodeAuditCursor(cursor) : null
  if (cursor && !position) throw new WorkspaceError('validationGeneric')
  await requireAdmin(actorId, workspaceId)
  const { since, until } = auditWindow({ from, until: to }, now)
  const rows = await db.select({
    id: workspaceAuditEvents.id, createdAt: workspaceAuditEvents.createdAt, micros,
    actorType: workspaceAuditEvents.actorType, actorName: workspaceAuditEvents.actorName, action: workspaceAuditEvents.action,
    category: workspaceAuditEvents.category, targetType: workspaceAuditEvents.targetType, targetLabel: workspaceAuditEvents.targetLabel,
    metadata: workspaceAuditEvents.metadata, ip: sql<string | null>`host(${workspaceAuditEvents.ip})`, geoCity: workspaceAuditEvents.geoCity,
  }).from(workspaceAuditEvents).where(and(
    eq(workspaceAuditEvents.workspaceId, workspaceId),
    gt(workspaceAuditEvents.createdAt, since),
    // The window's end only when one was asked for: an unbounded read also shows what lands while it pages.
    to ? lte(workspaceAuditEvents.createdAt, until) : undefined,
    filter === 'security' ? eq(workspaceAuditEvents.category, 'security') : undefined,
    categories ? inArray(workspaceAuditEvents.category, categories) : undefined,
    position ? sql`(${workspaceAuditEvents.createdAt}, ${workspaceAuditEvents.id}) < (timestamptz 'epoch' + ${position.micros}::bigint * interval '1 microsecond', ${position.id}::uuid)` : undefined,
  )).orderBy(desc(workspaceAuditEvents.createdAt), desc(workspaceAuditEvents.id)).limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    events: page.map(row => ({ id: row.id, createdAt: row.createdAt.toISOString(), actorType: row.actorType, actorName: row.actorName, action: row.action, category: row.category, targetType: row.targetType, targetLabel: row.targetLabel, metadata: row.metadata, ip: row.ip, geoCity: row.geoCity })),
    nextCursor: rows.length > limit && last ? encodeAuditCursor({ micros: last.micros, id: last.id }) : null,
  }
}

/** Every event in a stable window. An oversized export is refused, never silently truncated. */
export async function exportWorkspaceAudit(actorId: string, workspaceId: string, filter: unknown, now = new Date(), cap = 50_000): Promise<AuditEventView[]> {
  const parsed = auditPageInput.parse({ filter })
  const { createAuditExport } = await import('./export')
  return (await createAuditExport(actorId, workspaceId, parsed.filter, now, cap)).events
}
