import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, lt, lte, sql, getTableColumns } from 'drizzle-orm'
import { z } from 'zod'
import { organizationAuditEvents, organizationAuditExports, organizationResourcePolicies, organizations } from '@/lib/db/governance-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { auditDigest, auditExportRecords } from '@/lib/audit/integrity'
import { AuditExportError, AUDIT_EXPORT_MAX } from '@/lib/audit/export'
import { requireOrganizationAdmin } from './organizations'
import { enqueueOrganizationAudit } from './audit'
import { armDueTimerAfterCommit } from '@/lib/due-timer'

export type OrganizationAuditManifest = {
  format: 'mikka-organization-audit-export'; version: 1; id: string; organizationId: string;
  createdAt: string; expiresAt: string; from: string; until: string; count: number; digest: string;
}
const exportInput = z.object({ from: z.iso.datetime({ offset: true }).optional(), until: z.iso.datetime({ offset: true }).optional() }).strict()
const columns = { ...getTableColumns(organizationAuditEvents), createdAtMicros: sql<string>`(extract(epoch from ${organizationAuditEvents.createdAt})*1000000)::bigint::text` }
type Event = typeof organizationAuditEvents.$inferSelect & { createdAtMicros: string }
const view = (row: Event) => ({ ...row, createdAt: row.createdAt.toISOString() })

/** Org events contain administrative metadata only. Workspace event exports keep their separate Workspace-admin ACL. */
export async function createOrganizationAuditExport(organizationId: string, actorId: string, input: unknown, now = new Date(), cap = AUDIT_EXPORT_MAX) {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > AUDIT_EXPORT_MAX) throw new RangeError('Invalid audit export limit')
  const value = exportInput.parse(input)
  const until = value.until ? new Date(value.until) : now
  const from = value.from ? new Date(value.from) : new Date(until.getTime() - 90 * 86_400_000)
  if (from >= until || until > now || until.getTime() - from.getTime() > 366 * 86_400_000) throw new AuditExportError('auditExportUnavailable', 400)
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, actorId, true)
    const rows = await tx.select(columns).from(organizationAuditEvents).where(and(eq(organizationAuditEvents.organizationId, organizationId), gt(organizationAuditEvents.createdAt, from), lte(organizationAuditEvents.createdAt, until)))
      .orderBy(desc(organizationAuditEvents.createdAt), desc(organizationAuditEvents.id)).limit(cap + 1)
    if (rows.length > cap) throw new AuditExportError('auditExportLimitExceeded', 413)
    const events = rows.map(view), records = auditExportRecords(events)
    const manifest: OrganizationAuditManifest = { format: 'mikka-organization-audit-export', version: 1, id: randomUUID(), organizationId,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(), from: from.toISOString(), until: until.toISOString(), count: events.length, digest: auditDigest(records) }
    await tx.insert(organizationAuditExports).values({ id: manifest.id, organizationId, createdBy: actorId, manifest, records, expiresAt: new Date(manifest.expiresAt) })
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.audit_exported', targetId: manifest.id, metadata: { count: events.length, digest: manifest.digest } })
    armDueTimerAfterCommit(tx, 'audit-retention')
    return { manifest, events }
  })
}

export async function readOrganizationAuditExport(organizationId: string, actorId: string, exportId: string, offset = 0, limit = 100, now = new Date()) {
  z.uuid().parse(exportId)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AuditExportError('auditExportUnavailable', 400)
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, actorId, true)
    const [saved] = await tx.select().from(organizationAuditExports).where(and(eq(organizationAuditExports.organizationId, organizationId), eq(organizationAuditExports.id, exportId), gt(organizationAuditExports.expiresAt, now))).limit(1)
    if (!saved) throw new AuditExportError('auditExportUnavailable', 404)
    if (saved.records.length !== saved.manifest.count || auditDigest(saved.records) !== saved.manifest.digest) throw new AuditExportError('auditExportChanged', 409)
    const expected = saved.records.slice(offset, offset + limit)
    const rows = expected.length ? await tx.select(columns).from(organizationAuditEvents).where(and(eq(organizationAuditEvents.organizationId, organizationId), inArray(organizationAuditEvents.id, expected.map(row => row.id)))) : []
    const byId = new Map(rows.map(row => [row.id, view(row)]))
    const events = expected.map(row => byId.get(row.id))
    if (events.some((event, index) => !event || auditDigest(event) !== expected[index].digest)) throw new AuditExportError('auditExportChanged', 409)
    return { manifest: saved.manifest, events, nextOffset: offset + expected.length < saved.manifest.count ? offset + expected.length : null }
  })
}

/** Deletion is explicit, bounded, and serialized with exports and legal-hold changes on the Org row. */
export async function applyOrganizationAuditRetention(organizationId: string, now = new Date()) {
  return workspaceDb.transaction(async tx => {
    const [organization] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).for('update').limit(1)
    if (!organization) return { deleted: 0, skipped: 'missing' as const }
    const [policy] = await tx.select().from(organizationResourcePolicies).where(eq(organizationResourcePolicies.organizationId, organizationId)).limit(1)
    if (policy?.legalHold) return { deleted: 0, skipped: 'legal_hold' as const }
    await tx.delete(organizationAuditExports).where(and(eq(organizationAuditExports.organizationId, organizationId), lte(organizationAuditExports.expiresAt, now)))
    if (policy?.auditRetentionDays == null) return { deleted: 0, skipped: 'retain' as const }
    const [lease] = await tx.select({ id: organizationAuditExports.id }).from(organizationAuditExports).where(and(eq(organizationAuditExports.organizationId, organizationId), gt(organizationAuditExports.expiresAt, now))).limit(1)
    if (lease) return { deleted: 0, skipped: 'active_export' as const }
    const cutoff = new Date(now.getTime() - policy.auditRetentionDays * 86_400_000)
    const rows = await tx.select({ id: organizationAuditEvents.id }).from(organizationAuditEvents).where(and(eq(organizationAuditEvents.organizationId, organizationId), lt(organizationAuditEvents.createdAt, cutoff)))
      .orderBy(asc(organizationAuditEvents.createdAt), asc(organizationAuditEvents.id)).limit(10_000)
    if (rows.length) {
      await tx.delete(organizationAuditEvents).where(and(eq(organizationAuditEvents.organizationId, organizationId), inArray(organizationAuditEvents.id, rows.map(row => row.id))))
      await enqueueOrganizationAudit(tx, { organizationId, actorId: 'system', action: 'organization.retention_applied', metadata: { count: rows.length, retentionDays: policy.auditRetentionDays } })
    }
    return { deleted: rows.length, skipped: null }
  })
}

export async function sweepOrganizationAuditRetention() {
  const policies = await workspaceDb.select({ id: organizations.id }).from(organizations).leftJoin(organizationResourcePolicies, eq(organizationResourcePolicies.organizationId, organizations.id))
    .where(sql`coalesce(${organizationResourcePolicies.legalHold},false)=false and (
      exists(select 1 from mikka_organization_audit_events a where a."organizationId"=${organizations.id}
        and a."createdAt"<now()-make_interval(days=>${organizationResourcePolicies.auditRetentionDays}))
      or exists(select 1 from mikka_organization_audit_exports e where e."organizationId"=${organizations.id} and e."expiresAt"<=now()))`)
    .orderBy(asc(organizations.id)).limit(50)
  let deleted = 0
  for (const policy of policies) deleted += (await applyOrganizationAuditRetention(policy.id)).deleted
  return { organizations: policies.length, deleted }
}
