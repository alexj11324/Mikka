import 'server-only'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { organizationBillingAccounts, organizationEntitlements, organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { workspaceEntitlements } from '@/lib/db/team-entitlements-schema'
import { workspaces } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, type WorkspaceTransaction } from '@/lib/workspace-access'
import { requireOrganizationAdmin } from '@/lib/governance/organizations'
import { GovernanceError } from '@/lib/governance/errors'
import { enqueueOrganizationAudit } from '@/lib/governance/audit'

export interface PlatformBillingAccount { organizationId: string | null; accountWorkspaceId: string }

/** Resolves platform-only spending. BYO resources retain their own payer. Not an authorization check. */
export async function resolvePlatformBillingAccount(workspaceId: string, source: Pick<WorkspaceTransaction, 'select'> = workspaceDb): Promise<PlatformBillingAccount> {
  const [account] = await source.select({ organizationId: organizationBillingAccounts.organizationId,
    accountWorkspaceId: organizationBillingAccounts.workspaceId }).from(organizationWorkspaces)
    .innerJoin(organizations, eq(organizations.id, organizationWorkspaces.organizationId))
    .innerJoin(organizationBillingAccounts, eq(organizationBillingAccounts.organizationId, organizationWorkspaces.organizationId))
    .where(and(eq(organizationWorkspaces.workspaceId, workspaceId), isNull(organizations.archivedAt))).limit(1)
  return account ?? { organizationId: null, accountWorkspaceId: workspaceId }
}

/** Reuses a selected Shared Workspace's account. No wallet/receipt is moved, copied or re-owned. */
export async function setOrganizationBillingAccount(actorId: string, organizationId: string, workspaceId: string | null) {
  z.uuid().parse(organizationId)
  if (workspaceId) z.uuid().parse(workspaceId)
  const [observed] = await workspaceDb.select().from(organizationBillingAccounts)
    .where(eq(organizationBillingAccounts.organizationId, organizationId)).limit(1)
  return workspaceDb.transaction(async tx => {
    const ids = [...new Set([workspaceId, observed?.workspaceId].filter((id): id is string => Boolean(id)))].sort()
    if (ids.length) await tx.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.id, ids)).orderBy(asc(workspaces.id)).for('update')
    for (const id of ids) {
      const { workspace } = await requireWorkspace(tx, id, actorId, true)
      if (workspace.kind !== 'team') throw new GovernanceError('personal_workspace')
    }
    const { membership } = await requireOrganizationAdmin(tx, organizationId, actorId)
    if (membership.role !== 'owner') throw new GovernanceError('access_denied')
    const [current] = await tx.select().from(organizationBillingAccounts).where(eq(organizationBillingAccounts.organizationId, organizationId)).limit(1)
    if (current?.workspaceId !== observed?.workspaceId) throw new GovernanceError('plan_changed')
    if ((current?.workspaceId ?? null) === workspaceId) return { organizationId, accountWorkspaceId: workspaceId }
    if (workspaceId) {
      const [link] = await tx.select().from(organizationWorkspaces).where(and(eq(organizationWorkspaces.workspaceId, workspaceId), eq(organizationWorkspaces.organizationId, organizationId))).limit(1)
      if (!link) throw new GovernanceError('workspace_attached')
      await tx.insert(organizationBillingAccounts).values({ organizationId, workspaceId, createdBy: actorId })
        .onConflictDoUpdate({ target: organizationBillingAccounts.organizationId, set: { workspaceId, updatedAt: new Date() } })
    } else await tx.delete(organizationBillingAccounts).where(eq(organizationBillingAccounts.organizationId, organizationId))
    const [grant] = workspaceId ? await tx.select().from(workspaceEntitlements).where(eq(workspaceEntitlements.workspaceId, workspaceId)).limit(1) : []
    const values = { billingWorkspaceId: workspaceId, billingPlan: grant?.billingPlan ?? 'free' as const,
      billingExpiresAt: grant?.billingExpiresAt ?? null, billingSubscriptionId: grant?.billingSubscriptionId ?? null,
      billingRevision: grant?.billingRevision ?? 0, updatedAt: new Date() }
    await tx.insert(organizationEntitlements).values({ organizationId, ...values })
      .onConflictDoUpdate({ target: organizationEntitlements.organizationId, set: values })
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.billing_account_changed',
      targetId: workspaceId ?? current?.workspaceId, metadata: { workspaceId, reason: workspaceId ? 'designated_existing_account' : 'released_account' } })
    return { organizationId, accountWorkspaceId: workspaceId }
  })
}
