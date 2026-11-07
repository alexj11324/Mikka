import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { looksLikeSecretValue, toAuditRow } from '@/lib/audit/events'
import { deploymentMode } from './edition'
import { GovernanceError } from './errors'
import { resolveEntitlements, type DeploymentMode, type PlanGrant } from './policy'

/** Operator input only. No route or server action exposes this capability. */
export const workspacePlanInput = z.object({
  workspaceId: z.uuid(), expectedPlan: z.enum(['free', 'pro', 'enterprise']),
  plan: z.enum(['free', 'pro']), source: z.enum(['cloud', 'license']),
  seatLimit: z.number().int().min(1).max(100_000).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  reason: z.enum(['evaluation', 'licensed', 'downgrade', 'correction']),
  operator: z.string().trim().min(1).max(120).refine(value => !looksLikeSecretValue(value)),
}).strict().refine(value => value.plan === 'pro' ? value.seatLimit !== null : value.seatLimit === null && value.expiresAt === null)

/** Uses the operator's existing database authority; never touches cards, credits or Stripe. */
export async function provisionWorkspacePlan(database: Pick<Pool, 'connect'>, input: unknown, options: { apply?: boolean; mode?: DeploymentMode } = {}) {
  const value = workspacePlanInput.parse(input)
  const mode = options.mode ?? deploymentMode()
  if (value.source !== (mode === 'cloud' ? 'cloud' : 'license')) throw new GovernanceError('invalid_request')
  if (value.expiresAt && new Date(value.expiresAt).getTime() <= Date.now()) throw new GovernanceError('invalid_request')
  const client = await database.connect()
  try {
    await client.query('begin')
    await client.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
    const { rows: [workspace] } = await client.query<{ kind: 'personal' | 'team' }>('select kind from mikka_workspaces where id=$1 for update', [value.workspaceId])
    if (!workspace) throw new GovernanceError('not_found')
    if (workspace.kind !== 'team') throw new GovernanceError('personal_workspace')
    // Binding/unbinding takes this same Workspace lock. Bound plans belong to the
    // Organization; a local grant would report success without changing access.
    const { rows: [organization] } = await client.query('select "organizationId" from mikka_organization_workspaces where "workspaceId"=$1', [value.workspaceId])
    if (organization) throw new GovernanceError('workspace_attached')
    const { rows: [previous] } = await client.query<PlanGrant>('select plan,source,"seatLimit","expiresAt" from mikka_workspace_entitlements where "workspaceId"=$1', [value.workspaceId])
    const before = resolveEntitlements({ kind: workspace.kind, mode, grant: previous })
    if (before.plan !== value.expectedPlan) throw new GovernanceError('plan_changed')
    const grant = { plan: value.plan, source: value.source, seatLimit: value.seatLimit, expiresAt: value.expiresAt ? new Date(value.expiresAt) : null }
    const after = resolveEntitlements({ kind: workspace.kind, mode, grant })
    const { rows: [{ activeHumans }] } = await client.query<{ activeHumans: number }>('select count(*)::int as "activeHumans" from mikka_workspace_members where "workspaceId"=$1 and status=\'active\'', [value.workspaceId])
    const changed = !previous || previous.plan !== grant.plan || previous.source !== grant.source || previous.seatLimit !== grant.seatLimit || previous.expiresAt?.getTime() !== grant.expiresAt?.getTime()
    // Validate the audit event even in dry-run; invalid/secret-bearing operator labels fail closed.
    const payload = toAuditRow({ workspaceId: value.workspaceId, actor: { type: 'system', id: value.operator, name: value.operator },
      action: 'workspace.entitlements_changed', target: { type: 'workspace', id: value.workspaceId },
      metadata: { fromPlan: before.plan, toPlan: value.plan, source: value.source, seatLimit: value.seatLimit, expiresAt: value.expiresAt, reason: value.reason } })
    if (options.apply && changed) {
      await client.query(`insert into mikka_workspace_entitlements ("workspaceId",plan,source,"seatLimit","expiresAt") values($1,$2,$3,$4,$5)
        on conflict ("workspaceId") do update set plan=excluded.plan,source=excluded.source,"seatLimit"=excluded."seatLimit","expiresAt"=excluded."expiresAt","updatedAt"=now()`,
      [value.workspaceId, grant.plan, grant.source, grant.seatLimit, grant.expiresAt])
      await client.query('insert into workspace_audit_outbox(id,"workspaceId",payload,"createdAt") values($1,$2,$3,now())', [randomUUID(), value.workspaceId, payload])
    }
    await client.query('commit')
    return { workspaceId: value.workspaceId, applied: !!options.apply, changed, before, after, activeHumans,
      overLimit: after.activeHumanLimit !== null && activeHumans > after.activeHumanLimit }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
}
