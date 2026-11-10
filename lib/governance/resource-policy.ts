import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { workspaceDb } from '@/lib/workspace-db'
import { pool } from '@/lib/db'
import { organizationEntitlements, organizationPolicyOutbox, organizationResourceApprovals, organizationResourcePolicies, organizationWorkspaces } from '@/lib/db/governance-schema'
import { requireWorkspace } from '@/lib/workspace-access'
import { requireOrganizationAdmin, getOrganizationWorkspaceIds } from './organizations'
import { enqueueOrganizationAudit } from './audit'
import { GovernanceError } from './errors'
import { deploymentMode } from './edition'
import { resolveEntitlements } from './policy'
import { armDueTimerAfterCommit } from '@/lib/due-timer'

export const organizationResourcePolicyInput = z.object({
  modelCredentialSharing: z.enum(['allow', 'approval_required', 'deny']), mcpSharing: z.enum(['allow', 'approval_required', 'deny']),
  allowedModelProviders: z.array(z.enum(['vercel-gateway', 'zerocat', 'openai-subscription', 'anthropic-subscription', 'api-key'])).max(5).nullable(),
  auditRetentionDays: z.number().int().min(1).max(36500).nullable(), legalHold: z.boolean(),
}).strict()

export async function readOrganizationResourcePolicy(organizationId: string, userId: string) {
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, userId)
    const [policy] = await tx.select().from(organizationResourcePolicies).where(eq(organizationResourcePolicies.organizationId, organizationId))
    const approvals = await tx.select().from(organizationResourceApprovals).where(eq(organizationResourceApprovals.organizationId, organizationId)).orderBy(asc(organizationResourceApprovals.createdAt)).limit(1000)
    return { policy: policy ?? { modelCredentialSharing: 'allow', mcpSharing: 'allow', allowedModelProviders: null, auditRetentionDays: null, legalHold: false, revision: 0 }, approvals }
  })
}

export async function configureOrganizationResourcePolicy(organizationId: string, userId: string, input: unknown) {
  const value = organizationResourcePolicyInput.parse(input)
  await workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, userId)
    const [grant] = await tx.select().from(organizationEntitlements).where(eq(organizationEntitlements.organizationId, organizationId))
    if (resolveEntitlements({ mode: deploymentMode(), kind: 'team', grant }).plan !== 'enterprise') throw new GovernanceError('feature_unavailable')
    const [previous] = await tx.select().from(organizationResourcePolicies).where(eq(organizationResourcePolicies.organizationId, organizationId))
    const revision = (previous?.revision ?? 0) + 1
    await tx.insert(organizationResourcePolicies).values({ organizationId, ...value, revision }).onConflictDoUpdate({ target: organizationResourcePolicies.organizationId, set: { ...value, revision, updatedAt: new Date() } })
    await enqueueOrganizationAudit(tx, { organizationId, actorId: userId, action: 'organization.policy_changed', metadata: { revision } })
    const rank = { allow: 2, approval_required: 1, deny: 0 }
    const changes = { modelCredentials: rank[value.modelCredentialSharing] < rank[previous?.modelCredentialSharing ?? 'allow'],
      mcp: rank[value.mcpSharing] < rank[previous?.mcpSharing ?? 'allow'],
      modelProviders: value.allowedModelProviders !== null && JSON.stringify(value.allowedModelProviders) !== JSON.stringify(previous?.allowedModelProviders ?? null) }
    if (Object.values(changes).some(Boolean)) await tx.insert(organizationPolicyOutbox).values({ id: randomUUID(), organizationId, workspaceIds: await getOrganizationWorkspaceIds(tx, organizationId), changes })
    armDueTimerAfterCommit(tx, 'audit-retention')
  })
  await retryOrganizationPolicyOutbox(organizationId)
  return readOrganizationResourcePolicy(organizationId, userId)
}

const approvalInput = z.object({ workspaceId: z.uuid(), kind: z.enum(['subscription', 'api_key', 'mcp']), resourceId: z.string().min(1).max(200) }).strict()
export async function requestOrganizationResourceApproval(organizationId: string, userId: string, input: unknown) {
  const value = approvalInput.parse(input)
  if (value.kind === 'subscription') {
    if (value.resourceId !== userId) throw new GovernanceError('access_denied')
  } else {
    z.uuid().parse(value.resourceId)
    const owned = value.kind === 'mcp'
      ? await pool.query('select 1 from personal_mcp_servers where id=$1 and user_id=$2', [value.resourceId, userId])
      : await pool.query('select 1 from model_api_keys where id=$1 and "ownerId"=$2', [value.resourceId, userId])
    if (!owned.rowCount) throw new GovernanceError('access_denied')
  }
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, value.workspaceId, userId)
    const [link] = await tx.select().from(organizationWorkspaces).where(and(eq(organizationWorkspaces.workspaceId, value.workspaceId), eq(organizationWorkspaces.organizationId, organizationId)))
    if (!link) throw new GovernanceError('access_denied')
    // An owner cannot erase a denial by submitting the request again.
    const [created] = await tx.insert(organizationResourceApprovals).values({ id: randomUUID(), organizationId, ...value, ownerId: userId }).onConflictDoNothing().returning({ id: organizationResourceApprovals.id })
    const [existing] = created ? [] : await tx.select({ id: organizationResourceApprovals.id }).from(organizationResourceApprovals).where(and(
      eq(organizationResourceApprovals.organizationId, organizationId), eq(organizationResourceApprovals.workspaceId, value.workspaceId),
      eq(organizationResourceApprovals.kind, value.kind), eq(organizationResourceApprovals.resourceId, value.resourceId), eq(organizationResourceApprovals.ownerId, userId)))
    const result = created ?? existing
    await enqueueOrganizationAudit(tx, { organizationId, actorId: userId, action: 'organization.resource_requested', targetId: result.id, metadata: { workspaceId: value.workspaceId } })
    return result
  })
}

export async function decideOrganizationResourceApproval(organizationId: string, actorId: string, input: unknown) {
  const value = z.object({ id: z.uuid(), status: z.enum(['approved', 'denied']) }).strict().parse(input)
  await workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, actorId)
    const [row] = await tx.update(organizationResourceApprovals).set({ status: value.status, decidedBy: actorId, updatedAt: new Date() }).where(and(eq(organizationResourceApprovals.id, value.id), eq(organizationResourceApprovals.organizationId, organizationId))).returning()
    if (!row) throw new GovernanceError('not_found')
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.resource_decided', targetId: value.id, metadata: { status: value.status } })
    if (value.status === 'denied') await tx.insert(organizationPolicyOutbox).values({ id: randomUUID(), organizationId, workspaceIds: [row.workspaceId], changes: { modelCredentials: row.kind !== 'mcp', mcp: row.kind === 'mcp', modelProviders: false } })
    armDueTimerAfterCommit(tx, 'audit-retention')
  })
  await retryOrganizationPolicyOutbox(organizationId)
}

/** The policy becomes authoritative in WS first. Stops are durable and run only after commit. */
export async function retryOrganizationPolicyOutbox(organizationId?: string) {
  const { workspacePool } = await import('@/lib/workspace-db')
  const { rows } = await workspacePool.query<{ id: string; organizationId: string; workspaceIds: string[]; changes: { modelCredentials: boolean; mcp: boolean; modelProviders: boolean } }>('select id,"organizationId","workspaceIds",changes from mikka_organization_policy_outbox where "deliveredAt" is null and ($1::uuid is null or "organizationId"=$1) order by "createdAt",id limit 50', [organizationId ?? null])
  const { stopRunsUsingSubscriptions } = await import('@/lib/personal-policy')
  const { stopRunsUsingApiKeys } = await import('@/lib/model-api-key-runs')
  const { workspaceResourcePolicy } = await import('./resource-access')
  const { stopRunsForPolicyChange, notifyStoppedPolicyRuns } = await import('@/lib/run-policy-stop')
  for (const receipt of rows) {
    for (const workspaceId of receipt.workspaceIds) {
      const policy = await workspaceResourcePolicy(workspaceId).catch(() => null)
      if (!policy || policy.organizationId !== receipt.organizationId) continue
      if (receipt.changes.modelCredentials) {
        await stopRunsUsingSubscriptions(pool, { workspaceId, othersOnly: true })
        await stopRunsUsingApiKeys(pool, { workspaceId, othersOnly: true })
      }
      if (receipt.changes.mcp) {
        const stopped = await pool.query<{ id: string; deviceId: string; stopped: boolean }>(`update agent_runs r set "stopRequestedAt"=clock_timestamp(),"leaseExpiresAt"=least(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
        where r."workspaceId"=$1 and r."stopRequestedAt" is null and r.status in ('queued','preparing','running','paused','waiting_input','finishing')
        and exists(select 1 from jsonb_array_elements(coalesce(r."agentDefinition"#>'{customMcp,servers}','[]'::jsonb)) s where s->>'ownerId'<>r."userId")
        returning r.id,r."deviceId",true as stopped`, [workspaceId])
        notifyStoppedPolicyRuns(pool, stopped.rows.filter(row => row.deviceId))
      }
      if (receipt.changes.modelProviders && policy.allowedModelProviders !== null) await stopRunsForPolicyChange(pool, { kind: 'workspace', workspaceId })
    }
    await workspacePool.query('update mikka_organization_policy_outbox set "deliveredAt"=now() where id=$1', [receipt.id])
  }
  return rows.length
}
