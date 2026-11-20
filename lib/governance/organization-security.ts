import 'server-only'
import { APIError } from 'better-auth'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspaceDb, workspacePool } from '@/lib/workspace-db'
import { twoFactorSessionState } from '@/lib/enterprise/two-factor'
import { requireEnterpriseOrganization } from '@/lib/enterprise/access'
import { commitIdentityChange, deliverIdentityAudits } from '@/lib/enterprise/audit-outbox'
import { lockOrganizationLiveAuthority, revokeOrganizationLiveCapabilities } from '@/lib/enterprise/live-store'
import { drainOrganizationLiveRevocations } from '@/lib/enterprise/live-authority'
import { requireOrganizationAdmin } from './organizations'
import { GovernanceError } from './errors'
import type { OrganizationSecurityPolicy, PersonalSecurityState } from './organization-security-contract'

const policyInput = z.object({ requireTwoFactor: z.boolean(), gracePeriodDays: z.number().int().min(0).max(30).default(7) }).strict()
type PolicyRow = { requireTwoFactor: boolean; twoFactorGraceDays: number; twoFactorRequiredAt: Date | null }

function policyView(row?: PolicyRow): OrganizationSecurityPolicy {
  const requiredAt = row?.twoFactorRequiredAt ?? null
  const gracePeriodDays = row?.twoFactorGraceDays ?? 7
  return { requireTwoFactor: row?.requireTwoFactor ?? false, gracePeriodDays,
    requiredAt: requiredAt?.toISOString() ?? null,
    graceEndsAt: requiredAt ? new Date(requiredAt.getTime() + gracePeriodDays * 86_400_000).toISOString() : null }
}

export async function readOrganizationSecurity(organizationId: string, userId: string) {
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, userId)
    const { rows: [policy] } = await pool.query<PolicyRow>(`SELECT "requireTwoFactor","twoFactorGraceDays","twoFactorRequiredAt"
      FROM enterprise_org_policy WHERE "organizationId"=$1`, [organizationId])
    return { policy: policyView(policy) }
  })
}

export async function configureOrganizationSecurity(organizationId: string, userId: string, sessionId: string, input: unknown) {
  const value = policyInput.parse(input)
  const policy = await workspaceDb.transaction(async workspaceTx => {
    await requireOrganizationAdmin(workspaceTx, organizationId, userId)
    await requireEnterpriseOrganization(userId, organizationId, sessionId)
    // The enabling administrator verifies their own factor before enforcing it on anyone.
    if (value.requireTwoFactor && !(await twoFactorSessionState(userId, sessionId)).verified) throw new GovernanceError('access_denied')
    return commitIdentityChange({ organizationId, actorId: userId, action: 'organization.policy_changed',
      metadata: { enabled: value.requireTwoFactor, count: value.gracePeriodDays, reason: 'two_factor' } }, async tx => {
      await lockOrganizationLiveAuthority(tx, organizationId)
      const { rows: [updated] } = await tx.query<PolicyRow>(`INSERT INTO enterprise_org_policy
        ("organizationId","requireTwoFactor","twoFactorGraceDays","twoFactorRequiredAt")
        VALUES ($1,$2,$3,CASE WHEN $2 THEN now() ELSE NULL END)
        ON CONFLICT ("organizationId") DO UPDATE SET "requireTwoFactor"=excluded."requireTwoFactor",
          "twoFactorGraceDays"=excluded."twoFactorGraceDays",
          "twoFactorRequiredAt"=CASE WHEN NOT excluded."requireTwoFactor" THEN NULL
            WHEN enterprise_org_policy."requireTwoFactor" THEN enterprise_org_policy."twoFactorRequiredAt" ELSE now() END,
          "updatedAt"=now()
        RETURNING "requireTwoFactor","twoFactorGraceDays","twoFactorRequiredAt"`, [organizationId, value.requireTwoFactor, value.gracePeriodDays])
      await revokeOrganizationLiveCapabilities(tx, organizationId)
      return policyView(updated)
    }, { deferDelivery: true })
  })
  await deliverIdentityAudits(organizationId)
  await drainOrganizationLiveRevocations(organizationId)
  return { policy }
}

async function securityOrganizations(userId: string) {
  return (await workspacePool.query<{ id: string; name: string }>(`SELECT DISTINCT o.id,o.name FROM mikka_organizations o
    LEFT JOIN mikka_organization_members m ON m."organizationId"=o.id AND m."userId"=$1 AND m.status='active'
    LEFT JOIN mikka_organization_workspaces w ON w."organizationId"=o.id
    LEFT JOIN mikka_workspace_members wm ON wm."workspaceId"=w."workspaceId" AND wm."userId"=$1 AND wm.status='active'
    WHERE o."archivedAt" IS NULL AND (m."userId" IS NOT NULL OR wm."userId" IS NOT NULL) ORDER BY o.id`, [userId])).rows
}

/** Personal access stays available to enroll, step up, or use the native recovery codes. */
export async function readPersonalSecurity(userId: string, sessionId: string): Promise<PersonalSecurityState> {
  const [state, organizations] = await Promise.all([twoFactorSessionState(userId, sessionId), securityOrganizations(userId)])
  const { rows: policies } = organizations.length ? await pool.query<PolicyRow & { organizationId: string }>(`SELECT
    "organizationId","requireTwoFactor","twoFactorGraceDays","twoFactorRequiredAt" FROM enterprise_org_policy
    WHERE "organizationId"=ANY($1::uuid[])`, [organizations.map(organization => organization.id)]) : { rows: [] }
  return { twoFactorEnabled: state.enabled, sessionVerified: state.verified,
    organizations: organizations.map(organization => {
      const policy = policyView(policies.find(row => row.organizationId === organization.id))
      const status = !policy.requireTwoFactor ? 'not_required' : state.verified ? 'verified'
        : policy.graceEndsAt && Date.parse(policy.graceEndsAt) > Date.now() ? 'grace'
          : state.enabled ? 'verification_required' : 'enrollment_required'
      return { organizationId: organization.id, name: organization.name, requireTwoFactor: policy.requireTwoFactor,
        graceEndsAt: policy.graceEndsAt, status }
    }) }
}

export async function assertTwoFactorCanBeDisabled(userId: string) {
  const organizations = await securityOrganizations(userId)
  if (!organizations.length) return
  const { rows } = await pool.query('SELECT 1 FROM enterprise_org_policy WHERE "organizationId"=ANY($1::uuid[]) AND "requireTwoFactor" LIMIT 1',
    [organizations.map(organization => organization.id)])
  if (rows.length) throw new APIError('FORBIDDEN', { code: 'TWO_FACTOR_REQUIRED', message: 'Organization requires two-factor authentication' })
}
