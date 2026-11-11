import { z } from 'zod'
import type { Pool } from 'pg'
import { looksLikeSecretValue } from '@/lib/audit/events'
import { organizationAuditRow } from '@/lib/governance/audit-events'
import { deploymentMode } from '@/lib/governance/edition'
import { GovernanceError } from '@/lib/governance/errors'
import { resolveEntitlements, type DeploymentMode, type PlanGrant } from '@/lib/governance/policy'

/** Operator-only input. Organization members cannot grant their own Enterprise license. */
export const organizationPlanInput = z.object({
  organizationId: z.uuid(), expectedPlan: z.enum(['free', 'pro', 'enterprise']),
  plan: z.enum(['free', 'enterprise']), source: z.enum(['cloud', 'license']),
  seatLimit: z.number().int().min(1).max(100_000).nullable().default(null),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  reason: z.enum(['evaluation', 'licensed', 'downgrade', 'correction']),
  operator: z.string().trim().min(1).max(120).refine(value => !looksLikeSecretValue(value)),
}).strict().refine(value => value.plan === 'enterprise' || value.seatLimit === null && value.expiresAt === null)

/** Existing Workspace-database operator authority is required. No payment or membership mutation. */
export async function provisionOrganizationPlan(database: Pick<Pool, 'connect'>, input: unknown, options: { apply?: boolean; mode?: DeploymentMode } = {}) {
  const value = organizationPlanInput.parse(input)
  const mode = options.mode ?? deploymentMode()
  if (value.source !== (mode === 'cloud' ? 'cloud' : 'license')) throw new GovernanceError('invalid_request')
  if (value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) throw new GovernanceError('invalid_request')
  const client = await database.connect()
  try {
    await client.query('begin')
    await client.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
    // Admissions and Workspace binding take this same lock after their Workspace lock.
    // This operation never acquires a Workspace lock while holding the Organization lock.
    const { rows: [organization] } = await client.query<{ archivedAt: Date | null }>('select "archivedAt" from mikka_organizations where id=$1 for update', [value.organizationId])
    if (!organization) throw new GovernanceError('not_found')
    if (organization.archivedAt) throw new GovernanceError('access_denied')
    const { rows: [previous] } = await client.query<PlanGrant>('select plan,source,"seatLimit","expiresAt" from mikka_organization_entitlements where "organizationId"=$1', [value.organizationId])
    const before = resolveEntitlements({ kind: 'team', mode, grant: previous })
    if (before.plan !== value.expectedPlan) throw new GovernanceError('invalid_request')
    const grant = { plan: value.plan, source: value.source, seatLimit: value.seatLimit, expiresAt: value.expiresAt ? new Date(value.expiresAt) : null }
    const after = resolveEntitlements({ kind: 'team', mode, grant })
    const { rows: [{ activeHumans }] } = await client.query<{ activeHumans: number }>(`select count(distinct m."userId")::int as "activeHumans" from mikka_workspace_members m
      join mikka_organization_workspaces w on w."workspaceId"=m."workspaceId" where w."organizationId"=$1 and m.status='active'`, [value.organizationId])
    const changed = !previous || previous.plan !== grant.plan || previous.source !== grant.source || previous.seatLimit !== grant.seatLimit || previous.expiresAt?.getTime() !== grant.expiresAt?.getTime()
    const audit = organizationAuditRow({ organizationId: value.organizationId, actorId: `operator:${value.operator}`, action: 'entitlement.changed', targetId: value.organizationId,
      metadata: { fromPlan: before.plan, toPlan: value.plan, source: value.source, seatLimit: value.seatLimit, expiresAt: value.expiresAt, reason: value.reason } })
    if (options.apply && changed) {
      await client.query(`insert into mikka_organization_entitlements ("organizationId",plan,source,"seatLimit","expiresAt") values($1,$2,$3,$4,$5)
        on conflict ("organizationId") do update set plan=excluded.plan,source=excluded.source,"seatLimit"=excluded."seatLimit","expiresAt"=excluded."expiresAt","updatedAt"=now()`,
      [value.organizationId, grant.plan, grant.source, grant.seatLimit, grant.expiresAt])
      await client.query(`insert into mikka_organization_audit_events (id,"organizationId","actorId",action,"targetId",metadata,result,"correlationId","createdAt") values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [audit.id, audit.organizationId, audit.actorId, audit.action, audit.targetId, audit.metadata, audit.result, audit.correlationId, audit.createdAt])
    }
    await client.query('commit')
    return { organizationId: value.organizationId, applied: !!options.apply, changed, before, after, activeHumans,
      overLimit: after.activeHumanLimit !== null && activeHumans > after.activeHumanLimit }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
}
