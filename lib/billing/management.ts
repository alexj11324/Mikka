import 'server-only'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaces, workspaceMembers } from '@/lib/db/workspace-schema'
import { organizationBillingAccounts, organizationMembers, organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { requireOrganizationAdmin } from '@/lib/governance/organizations'
import type { EnterprisePrincipal } from '@/lib/enterprise/principal'
import { currentMonth, monthBounds } from '@/lib/usage/month'
import { readBillingAccount, billingPortalUrl, planCheckoutUrl } from './service'
import { readCreditBillingAccount } from './history'
import { readResourceBudgets } from './resource-budgets'
import { setWorkspaceBudget } from './budget-service'
import { saveAutoRechargePolicy } from './auto-recharge'
import { setOrganizationBillingAccount } from './organization-account'
import { pointsPurchaseUrl } from './points-purchase'
import { resolveAppOrigin } from '@/lib/auth-config'
import { withBasePath } from '@/lib/base-path'
import { ensureLegacyVerification } from '@/lib/abuse/runtime'
import { withBillingAuthority } from './authority'
import type { BillingManagementOperation, BillingManagementView, BillingScope } from './management-contract'

export const billingScopeSchema = z.object({ kind: z.enum(['workspace', 'organization']), id: z.uuid() })

/** Finance metadata only. Never reads a title, prompt, output, file or credential reference. */
export async function billingManagementView(actorId: string, target: BillingScope, selectedWorkspaceId?: string | null,
  principal?: EnterprisePrincipal): Promise<BillingManagementView> {
  billingScopeSchema.parse(target)
  if (selectedWorkspaceId) z.uuid().parse(selectedWorkspaceId)
  if (target.kind === 'workspace') {
    await workspaceDb.transaction(tx => requireWorkspace(tx, target.id, actorId, true, principal))
    await ensureLegacyVerification(target.id)
  }
  return workspaceDb.transaction(async tx => {
    let scopeName = '', organizationId: string | null = null
    if (target.kind === 'workspace') {
      const { workspace } = await requireWorkspace(tx, target.id, actorId, true, principal)
      scopeName = workspace.name
      const [link] = await tx.select({ id: organizationWorkspaces.organizationId }).from(organizationWorkspaces)
        .innerJoin(organizationMembers, and(eq(organizationMembers.organizationId, organizationWorkspaces.organizationId),
          eq(organizationMembers.userId, actorId), eq(organizationMembers.status, 'active')))
        .where(and(eq(organizationWorkspaces.workspaceId, target.id), inArray(organizationMembers.role, ['owner', 'admin']))).limit(1)
      organizationId = principal?.kind === 'pat' ? null : link?.id ?? null
    } else organizationId = target.id
    let organization: BillingManagementView['organization'] = null
    let linked: { id: string; name: string; ownerId: string; kind: string }[] = []
    if (organizationId) {
      const authority = await requireOrganizationAdmin(tx, organizationId, actorId)
      if (!scopeName) scopeName = authority.organization.name
      linked = await tx.select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.userId, kind: workspaces.kind }).from(organizationWorkspaces)
        .innerJoin(workspaces, eq(workspaces.id, organizationWorkspaces.workspaceId))
        .where(eq(organizationWorkspaces.organizationId, organizationId)).orderBy(asc(workspaces.name))
      const [account] = await tx.select().from(organizationBillingAccounts).where(eq(organizationBillingAccounts.organizationId, organizationId)).limit(1)
      organization = { id: organizationId, name: authority.organization.name, role: authority.membership.role as 'owner' | 'admin',
        accountWorkspaceId: account?.workspaceId ?? null, canDesignate: false, accounts: [] }
    }
    const [ownWorkspace] = target.kind === 'workspace' ? await tx.select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.userId, kind: workspaces.kind })
      .from(workspaces).where(eq(workspaces.id, target.id)).limit(1) : []
    if (target.kind === 'workspace' && !ownWorkspace) throw new WorkspaceError('workspaceAccessDenied')
    const available = target.kind === 'workspace' ? [ownWorkspace!] : linked
    const accountId = target.kind === 'organization' ? organization?.accountWorkspaceId ?? null : target.id
    const allIds = [...new Set([...available.map(row => row.id), ...linked.map(row => row.id)])]
    const memberships = allIds.length ? await tx.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(inArray(workspaceMembers.workspaceId, allIds), eq(workspaceMembers.userId, actorId), eq(workspaceMembers.status, 'active'))) : []
    const administrable = new Set(memberships.filter(row => row.role === 'admin').map(row => row.workspaceId))
    if (organization) {
      organization.canDesignate = organization.role === 'owner' && (!organization.accountWorkspaceId || administrable.has(organization.accountWorkspaceId))
      organization.accounts = linked.filter(row => row.kind === 'team').map(row => ({ id: row.id, name: row.name, selectable: administrable.has(row.id) }))
    }
    const budgetWorkspaceId = selectedWorkspaceId ?? accountId ?? available[0]?.id ?? null
    if (budgetWorkspaceId && !available.some(row => row.id === budgetWorkspaceId)) throw new WorkspaceError('workspaceAccessDenied')
    const members = budgetWorkspaceId ? await tx.select({ id: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, budgetWorkspaceId), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaceMembers.name)) : []
    const account = accountId ? [...available, ...linked].find(row => row.id === accountId) : null
    if (accountId && !account) throw new WorkspaceError('workspaceAccessDenied')
    const [designation] = accountId ? await tx.select().from(organizationBillingAccounts).where(eq(organizationBillingAccounts.workspaceId, accountId)).limit(1) : []
    const canManageRecharge = Boolean(account && (designation ? organization?.id === designation.organizationId && organization.role === 'owner' : account.ownerId === actorId))
    const memberCount = target.kind === 'organization'
      ? (await tx.select({ n: sql<number>`count(*)::int` }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, target.id), eq(organizationMembers.status, 'active'))))[0]?.n ?? 0 : members.length
    const organizationChoices = principal?.kind === 'pat' ? [] : await tx.select({ id: organizations.id, name: organizations.name }).from(organizations)
      .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
      .where(and(eq(organizationMembers.userId, actorId), eq(organizationMembers.status, 'active'), inArray(organizationMembers.role, ['owner', 'admin']), isNull(organizations.archivedAt))).orderBy(asc(organizations.name))
    const [payer] = target.kind === 'workspace' ? await tx.select({ id: organizationBillingAccounts.workspaceId }).from(organizationWorkspaces)
      .innerJoin(organizationBillingAccounts, eq(organizationBillingAccounts.organizationId, organizationWorkspaces.organizationId)).where(eq(organizationWorkspaces.workspaceId, target.id)).limit(1) : []
    const platformAccountWorkspaceId = target.kind === 'workspace' ? payer?.id ?? target.id : accountId
    const attributionMembers = target.kind === 'organization' ? await tx.select({ id: organizationMembers.userId, name: organizationMembers.name }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, target.id), eq(organizationMembers.status, 'active'))) : members
    const month = currentMonth(), { start, end } = monthBounds(month)
    const usageIds = available.map(row => row.id)
    const [billing, credits, budgets, totals, external, policies] = await Promise.all([
      accountId ? readBillingAccount(accountId, process.env, memberCount) : null,
      accountId ? readCreditBillingAccount(accountId) : null,
      budgetWorkspaceId ? readResourceBudgets(pool, [budgetWorkspaceId]) : [],
      pool.query<{ id: string | null; cost: number; held: number; unknown: number }>(`select "actorId" id,
        coalesce(sum("costMicroUsd") filter(where state='settled'),0)::float8 cost,
        coalesce(sum(coalesce("costMicroUsd","holdMicroUsd")) filter(where state in ('pending','unknown')),0)::float8 held,
        count(*) filter(where state='unknown' or (state='settled' and "costMicroUsd" is null))::int unknown
        from hosted_usage where "createdAt">=$1 and "createdAt"<$2 and state<>'failed'
        and ($3::boolean and "workspaceId"=$4::uuid or not $3::boolean and coalesce("usageWorkspaceId","workspaceId")=any($5::uuid[])) group by "actorId"`,
        [start, end, target.kind === 'organization', accountId, usageIds]),
      pool.query<{ count: number }>(`select count(*)::int count from agent_runs where "workspaceId"=any($1::uuid[]) and "createdAt">=$2 and "createdAt"<$3
        and "agentDefinition"->'executionIdentity'->>'version' in ('1','2') and (
        "agentDefinition"->'executionIdentity'->'billingAccount'->'model'->>'amount'='provider_unknown'
        or "agentDefinition"->'executionIdentity'->'billingAccount'->'runtime'->>'amount'='provider_unknown')`, [usageIds, start, end]),
      pool.query<{ available: boolean }>(`select to_regclass('resource_access_policies') is not null available`),
    ])
    const resources = budgetWorkspaceId && policies.rows[0]?.available ? (await pool.query<BillingManagementView['resourceTargets'][number]>(`
      select id,kind,visibility,"ownerId" from resource_access_policies where "workspaceId"=$1 and kind in ('project','thread') order by kind,id limit 200`, [budgetWorkspaceId])).rows : []
    const names = new Map(attributionMembers.map(member => [member.id, member.name]))
    return { scope: { ...target, name: scopeName! }, account: account ? { workspaceId: account.id, name: account.name } : null,
      billing, credits, organizations: organizationChoices, platformAccountWorkspaceId, canPurchasePlatform: accountId === platformAccountWorkspaceId, canManagePayments: Boolean(accountId && administrable.has(accountId)), canManageRecharge,
      canManageBudget: Boolean(budgetWorkspaceId && administrable.has(budgetWorkspaceId)), organization,
      budgetWorkspaceId, workspaces: available.map(row => ({ id: row.id, name: row.name, canEdit: administrable.has(row.id) })), members,
      resourceTargets: resources, resourceTargetsAvailable: Boolean(policies.rows[0]?.available), budgets,
      usage: { month, costMicroUsd: totals.rows.reduce((sum, row) => sum + row.cost, 0), reservedMicroUsd: totals.rows.reduce((sum, row) => sum + row.held, 0),
        unknownCalls: totals.rows.reduce((sum, row) => sum + row.unknown, 0), externalUnknownRuns: external.rows[0]?.count ?? 0,
        members: totals.rows.map(row => ({ id: row.id, name: row.id ? names.get(row.id) ?? null : null, costMicroUsd: row.cost, unknownCalls: row.unknown })) } }
  })
}

const operation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('budget'), workspaceId: z.uuid(), budget: z.unknown() }).strict(),
  z.object({ action: z.literal('account'), workspaceId: z.uuid().nullable() }).strict(),
  z.object({ action: z.literal('recharge'), policy: z.unknown(), accountWorkspaceId: z.uuid() }).strict(),
  z.object({ action: z.enum(['checkout', 'portal']), accountWorkspaceId: z.uuid() }).strict(),
  z.object({ action: z.literal('topup'), amount: z.number(), locale: z.enum(['en', 'zh-CN']), accountWorkspaceId: z.uuid() }).strict(),
])

export async function mutateBillingManagement(actorId: string, target: BillingScope, raw: BillingManagementOperation | unknown, principal?: EnterprisePrincipal) {
  const value = operation.parse(raw)
  const current = await billingManagementView(actorId, target, value.action === 'budget' ? value.workspaceId : undefined, principal)
  if (value.action === 'account') {
    if (!current.organization?.canDesignate || (value.workspaceId && !current.organization.accounts.some(row => row.id === value.workspaceId && row.selectable))) throw new WorkspaceError('workspaceAccessDenied')
    return setOrganizationBillingAccount(actorId, current.organization.id, value.workspaceId)
  }
  if (value.action === 'budget') {
    if (!current.canManageBudget) throw new WorkspaceError('workspaceAccessDenied')
    return setWorkspaceBudget(actorId, value.workspaceId, value.budget)
  }
  if (!current.account) throw new WorkspaceError('billingNoSubscription')
  if (value.accountWorkspaceId !== current.account.workspaceId) throw new WorkspaceError('billingPolicyChanged')
  if (value.action === 'recharge') {
    if (!current.canManageRecharge) throw new WorkspaceError('workspaceAccessDenied')
    return saveAutoRechargePolicy(actorId, current.account.workspaceId, value.policy)
  }
  if (!current.canManagePayments) throw new WorkspaceError('workspaceAccessDenied')
  if (value.action !== 'portal' && !current.canPurchasePlatform) throw new WorkspaceError('billingPolicyChanged')
  const accountId = current.account.workspaceId
  return withBillingAuthority(actorId, accountId, async () => {
    if (value.action === 'topup') return pointsPurchaseUrl(actorId, accountId, value.amount, value.locale)
    const origin = resolveAppOrigin(process.env)
    if (!origin) throw new WorkspaceError('billingNotConfigured')
    const back = new URL(withBasePath('/settings'), origin)
    back.searchParams.set('section', 'billing'); back.searchParams.set('workspace', accountId)
    return value.action === 'portal' ? billingPortalUrl(actorId, accountId, back.href)
      : planCheckoutUrl(actorId, accountId, back.href)
  }, { organizationId: target.kind === 'organization' ? target.id : undefined, ownPlatformAccount: value.action !== 'portal', principal })
}
