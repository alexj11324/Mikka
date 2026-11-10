import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspaceBilling } from '@/lib/db/schema'
import { organizationBillingAccounts } from '@/lib/db/governance-schema'
import { workspaces } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { requireOrganizationAdmin } from '@/lib/governance/organizations'
import { recordAudit } from '@/lib/audit/write'

export type { AutoRechargePolicyView } from './contract'
import type { AutoRechargePolicyView } from './contract'

/**
 * Stripe Managed Payments currently supports Checkout/Payment Links, not raw
 * off-session PaymentIntents or out-of-period invoices. Keep the existing MoR
 * contract. A saved limit is never authorization to switch payment providers.
 * https://docs.stripe.com/payments/managed-payments#unsupported-integrations
 */
export function autoRechargePolicy(row?: Pick<typeof workspaceBilling.$inferSelect, 'autoRechargeThreshold' | 'autoRechargeAmountPoints' | 'autoRechargeMonthlyCap' | 'autoRechargeRevision'>): AutoRechargePolicyView {
  return { state: 'provider_unsupported', enabled: false, provider: 'stripe_managed_payments',
    thresholdPoints: row?.autoRechargeThreshold ?? null, amountPoints: row?.autoRechargeAmountPoints ?? null,
    monthlyCapPoints: row?.autoRechargeMonthlyCap ?? null, revision: row?.autoRechargeRevision ?? 0 }
}

const input = z.object({ enabled: z.boolean(), consent: z.boolean().default(false), expectedRevision: z.number().int().nonnegative(),
  thresholdPoints: z.number().int().min(0).max(100_000_000), amountPoints: z.union([z.literal(1000), z.literal(2500), z.literal(5000)]),
  monthlyCapPoints: z.number().int().min(1000).max(100_000_000) }).strict()
  .refine(value => value.thresholdPoints < value.amountPoints && value.monthlyCapPoints >= value.amountPoints)
  .refine(value => !value.enabled || value.consent)

/** Owner-only saved limits/revocation. Enabling an unsupported payment flow is refused before any provider I/O. */
export async function saveAutoRechargePolicy(actorId: string, accountWorkspaceId: string, raw: unknown) {
  const value = input.parse(raw)
  z.uuid().parse(accountWorkspaceId)
  return workspaceDb.transaction(async ws => {
    const [workspace] = await ws.select({ id: workspaces.id, ownerId: workspaces.userId }).from(workspaces)
      .where(eq(workspaces.id, accountWorkspaceId)).for('update').limit(1)
    if (!workspace) throw new WorkspaceError('workspaceAccessDenied')
    const [account] = await ws.select().from(organizationBillingAccounts).where(eq(organizationBillingAccounts.workspaceId, accountWorkspaceId)).limit(1)
    let actorName: string
    if (account) {
      const { membership } = await requireOrganizationAdmin(ws, account.organizationId, actorId)
      if (membership.role !== 'owner') throw new WorkspaceError('workspaceAccessDenied')
      actorName = membership.name
    } else {
      const { membership } = await requireWorkspace(ws, accountWorkspaceId, actorId, true)
      if (workspace.ownerId !== actorId) throw new WorkspaceError('workspaceAccessDenied')
      actorName = membership.name
    }
    if (value.enabled) throw new WorkspaceError('billingAutoRechargeUnavailable')
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${accountWorkspaceId}`},0))`)
      const [prior] = await tx.select().from(workspaceBilling).where(eq(workspaceBilling.workspaceId, accountWorkspaceId)).for('update').limit(1)
      if ((prior?.autoRechargeRevision ?? 0) !== value.expectedRevision) throw new WorkspaceError('billingPolicyChanged')
      if (value.expectedRevision >= 2_147_483_647) throw new WorkspaceError('billingPolicyChanged')
      const saved = { autoRechargeEnabled: false, autoRechargeThreshold: value.thresholdPoints,
        autoRechargeAmountPoints: value.amountPoints, autoRechargeMonthlyCap: value.monthlyCapPoints,
        autoRechargeConsentBy: null, autoRechargeConsentAt: null, autoRechargeRevision: value.expectedRevision + 1, updatedAt: new Date() }
      await tx.insert(workspaceBilling).values({ workspaceId: accountWorkspaceId, ...saved })
        .onConflictDoUpdate({ target: workspaceBilling.workspaceId, set: saved })
      await recordAudit(tx, { workspaceId: accountWorkspaceId, actor: { type: 'user', id: actorId, name: actorName },
        action: 'billing.auto_recharge_changed', metadata: { enabled: false, thresholdCents: value.thresholdPoints,
          amountCents: value.amountPoints, monthlyCapCents: value.monthlyCapPoints, revision: saved.autoRechargeRevision } })
      return autoRechargePolicy(saved)
    })
  })
}
