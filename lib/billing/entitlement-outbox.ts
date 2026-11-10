import 'server-only'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { billingEntitlementOutbox } from '@/lib/db/schema'
import { organizationBillingAccounts, organizationEntitlements, organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { workspaceEntitlements } from '@/lib/db/team-entitlements-schema'
import { workspaces } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { enqueueWorkspaceAudit } from '@/lib/audit/delivery'
import { enqueueOrganizationAudit } from '@/lib/governance/audit'

type OutboxReceipt = typeof billingEntitlementOutbox.$inferSelect

/** APP owns the durable receipt; Workspace delivery happens after its commit. */
async function deliverBillingEntitlement(receipt: OutboxReceipt): Promise<void> {
  await workspaceDb.transaction(async tx => {
    const [workspace] = await tx.select({ id: workspaces.id, kind: workspaces.kind }).from(workspaces)
      .where(eq(workspaces.id, receipt.workspaceId)).for('update').limit(1)
    // Deletion retains the APP payment history. It cannot re-create a tenant.
    if (!workspace) return
    const [prior] = await tx.select().from(workspaceEntitlements).where(eq(workspaceEntitlements.workspaceId, workspace.id)).limit(1)
    const values = { billingPlan: receipt.plan, billingExpiresAt: receipt.expiresAt,
      billingRevision: receipt.revision, billingSubscriptionId: receipt.subscriptionId, updatedAt: new Date() }
    const applied = await tx.insert(workspaceEntitlements).values({ workspaceId: workspace.id, ...values })
      .onConflictDoUpdate({ target: workspaceEntitlements.workspaceId, set: values,
        setWhere: sql`${workspaceEntitlements.billingRevision}<${receipt.revision}` }).returning({ id: workspaceEntitlements.workspaceId })
    if (applied.length) await enqueueWorkspaceAudit(tx, { workspaceId: workspace.id,
      actor: { type: 'system', name: 'Stripe' }, action: 'workspace.entitlements_changed',
      metadata: { fromPlan: prior?.billingPlan ?? 'free', toPlan: receipt.plan, source: 'cloud', seatLimit: null,
        expiresAt: receipt.expiresAt?.toISOString() ?? null, reason: 'correction' } })
    const [link] = await tx.select().from(organizationWorkspaces).where(eq(organizationWorkspaces.workspaceId, workspace.id)).limit(1)
    if (!link || workspace.kind !== 'team') return
    const [organization] = await tx.select({ archivedAt: organizations.archivedAt }).from(organizations)
      .where(eq(organizations.id, link.organizationId)).for('update').limit(1)
    if (!organization || organization.archivedAt) return
    const [account] = await tx.select().from(organizationBillingAccounts).where(and(
      eq(organizationBillingAccounts.organizationId, link.organizationId), eq(organizationBillingAccounts.workspaceId, workspace.id))).limit(1)
    if (!account) return
    const [old] = await tx.select().from(organizationEntitlements).where(eq(organizationEntitlements.organizationId, link.organizationId)).limit(1)
    const appliedOrganization = await tx.insert(organizationEntitlements).values({ organizationId: link.organizationId,
      billingWorkspaceId: workspace.id, ...values }).onConflictDoUpdate({ target: organizationEntitlements.organizationId,
      set: { billingWorkspaceId: workspace.id, ...values }, setWhere: or(
        sql`${organizationEntitlements.billingWorkspaceId} IS DISTINCT FROM ${workspace.id}::uuid`,
        sql`${organizationEntitlements.billingRevision}<${receipt.revision}`) }).returning({ id: organizationEntitlements.organizationId })
    if (appliedOrganization.length) await enqueueOrganizationAudit(tx, { organizationId: link.organizationId, actorId: 'stripe',
      action: 'entitlement.changed', targetId: workspace.id, metadata: { fromPlan: old?.billingPlan ?? 'free', toPlan: receipt.plan,
        source: 'cloud', expiresAt: receipt.expiresAt?.toISOString() ?? null, revision: receipt.revision, reason: 'billing_projection' } })
  })
  await db.update(billingEntitlementOutbox).set({ deliveredAt: new Date() })
    .where(and(eq(billingEntitlementOutbox.eventId, receipt.eventId),
      eq(billingEntitlementOutbox.revision, receipt.revision), isNull(billingEntitlementOutbox.deliveredAt)))
}

/**
 * Stripe retries the verified webhook until delivery succeeds. APP receipts are
 * durable before we acquire a Workspace connection; no cross-database lock or
 * transaction is assumed. Duplicate/out-of-order deliveries use the monotone
 * account revision and never replay ledger grants or audit events.
 *
 * Every pending projection is attempted so one unavailable Workspace cannot
 * head-of-line block another tenant's delivery. When the caller names the
 * events it owns, only those failures fail its webhook; unrelated failures
 * stay queued for their own retry.
 */
export async function drainBillingEntitlements(eventIds?: readonly string[]): Promise<void> {
  const requested = eventIds ? new Set(eventIds) : undefined
  const rows = await db.select().from(billingEntitlementOutbox)
    .where(isNull(billingEntitlementOutbox.deliveredAt))
    .orderBy(asc(billingEntitlementOutbox.revision)).limit(100)
  let failure: unknown
  for (const receipt of rows) {
    try { await deliverBillingEntitlement(receipt) }
    catch (error) {
      if (!requested || requested.has(receipt.eventId)) { failure ??= error; continue }
      console.error('[billing] entitlement delivery pending', { eventId: receipt.eventId,
        name: error instanceof Error ? error.name : 'UnknownError' })
    }
  }
  if (failure) throw failure
  if (rows.length === 100) throw new Error('billing_entitlement_delivery_backlog')
}
