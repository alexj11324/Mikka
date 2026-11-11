import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { organizationAuditEvents, organizationBillingAccounts, organizationEntitlements, organizationMembers, organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { requireWorkspace, type WorkspaceTransaction } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { invalidateTaskWorkspaceOrganization } from '@/lib/task-workspace'
import { enqueueOrganizationAudit } from './audit'
import { activeHumanSeats, lockWorkspaceEntitlements } from './entitlements'
import { GovernanceError } from './errors'
import { assertOrganizationAccountWritable, assertOtherActiveOrganizationOwner } from './organization-ownership'
import { pool } from '@/lib/db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { enqueueMemberLifecycle, drainMemberLifecycleOutbox } from './member-outbox'
import { fenceWorkspaceLive, markWorkspaceLiveBinding, retireWorkspaceLiveBinding } from '../enterprise/live-authority'

export async function requireOrganizationAdmin(tx: WorkspaceTransaction, organizationId: string, userId: string, includeArchived = false) {
  z.uuid().parse(organizationId)
  // The organization row serializes ownership edits; callers touching a workspace lock it first.
  const [organization] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).for('update').limit(1)
  const [membership] = await tx.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active'))).limit(1)
  if (!organization || (!includeArchived && organization.archivedAt) || !membership || membership.role === 'member') throw new GovernanceError('access_denied')
  return { organization, membership }
}

export async function getOrganizationWorkspaceIds(tx: WorkspaceTransaction, organizationId: string) {
  const rows = await tx.select({ workspaceId: organizationWorkspaces.workspaceId }).from(organizationWorkspaces).where(eq(organizationWorkspaces.organizationId, organizationId)).orderBy(asc(organizationWorkspaces.workspaceId))
  return rows.map(row => row.workspaceId)
}

export async function listOrganizations(userId: string) {
  return workspaceDb.select({ id: organizations.id, name: organizations.name, role: organizationMembers.role }).from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active'), isNull(organizations.archivedAt))).orderBy(asc(organizations.createdAt))
}

export async function createOrganization(user: { id: string; name: string; email: string }, input: unknown) {
  const { name } = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(input)
  return workspaceDb.transaction(async tx => {
    await assertOrganizationAccountWritable(tx, user.id)
    const id = randomUUID()
    await tx.insert(organizations).values({ id, name, createdBy: user.id })
    await tx.insert(organizationMembers).values({ organizationId: id, userId: user.id, role: 'owner', name: user.name, email: user.email.toLowerCase() })
    await tx.insert(organizationEntitlements).values({ organizationId: id })
    await enqueueOrganizationAudit(tx, { organizationId: id, actorId: user.id, action: 'organization.created' })
    return { id, name, role: 'owner' as const }
  })
}

export async function organizationSummary(organizationId: string, userId: string) {
  return workspaceDb.transaction(async tx => {
    const { organization, membership } = await requireOrganizationAdmin(tx, organizationId, userId)
    const members = await tx.select().from(organizationMembers).where(eq(organizationMembers.organizationId, organizationId)).orderBy(asc(organizationMembers.createdAt))
    const workspaces = await getOrganizationWorkspaceIds(tx, organizationId)
    const activeHumans = (await activeHumanSeats(tx, workspaces[0] ?? organizationId, organizationId)).length
    const audit = await tx.select().from(organizationAuditEvents).where(eq(organizationAuditEvents.organizationId, organizationId)).orderBy(desc(organizationAuditEvents.createdAt)).limit(100)
    return { organization, role: membership.role, members, workspaceIds: workspaces, activeHumans, audit }
  })
}

export async function attachOrganizationWorkspace(organizationId: string, workspaceId: string, userId: string) {
  await workspaceDb.transaction(async tx => {
    const { workspace } = await requireWorkspace(tx, z.uuid().parse(workspaceId), userId, true)
    if (workspace.kind === 'personal') throw new GovernanceError('personal_workspace')
    await requireOrganizationAdmin(tx, organizationId, userId)
    const [existing] = await tx.select().from(organizationWorkspaces).where(eq(organizationWorkspaces.workspaceId, workspaceId)).limit(1)
    if (existing) {
      if (existing.organizationId !== organizationId) throw new GovernanceError('workspace_attached')
      return
    }
    await tx.insert(organizationWorkspaces).values({ workspaceId, organizationId })
    invalidateTaskWorkspaceOrganization(workspaceId)
    const scope = await lockWorkspaceEntitlements(tx, workspaceId)
    const seats = await activeHumanSeats(tx, workspaceId, organizationId)
    if (scope.entitlements.activeHumanLimit !== null && seats.length > scope.entitlements.activeHumanLimit) throw new GovernanceError('seat_limit')
    await enqueueOrganizationAudit(tx, { organizationId, actorId: userId, action: 'organization.workspace_attached', targetId: workspaceId })
    await markWorkspaceLiveBinding(workspaceId, organizationId, tx)
  })
  await fenceWorkspaceLive(workspaceId)
}

export async function detachOrganizationWorkspace(organizationId: string, workspaceId: string, userId: string) {
  await workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, z.uuid().parse(workspaceId), userId, true)
    await requireOrganizationAdmin(tx, organizationId, userId)
    const [billingAccount] = await tx.select().from(organizationBillingAccounts).where(and(eq(organizationBillingAccounts.organizationId, organizationId), eq(organizationBillingAccounts.workspaceId, workspaceId))).limit(1)
    if (billingAccount) throw new GovernanceError('billing_account_attached')
    const rows = await tx.delete(organizationWorkspaces).where(and(eq(organizationWorkspaces.workspaceId, workspaceId), eq(organizationWorkspaces.organizationId, organizationId))).returning()
    if (!rows.length) throw new GovernanceError('not_found')
    invalidateTaskWorkspaceOrganization(workspaceId)
    // Detaching or downgrading never destroys members. Further admissions enforce the resulting cap.
    await enqueueOrganizationAudit(tx, { organizationId, actorId: userId, action: 'organization.workspace_detached', targetId: workspaceId })
  })
  await retireWorkspaceLiveBinding(workspaceId, organizationId)
}

export async function updateOrganizationMember(organizationId: string, actorId: string, input: unknown) {
  const { userId, role } = z.object({ userId: z.string().min(1).max(200), role: z.enum(['owner', 'admin', 'member']) }).strict().parse(input)
  await workspaceDb.transaction(async tx => {
    await assertOrganizationAccountWritable(tx, userId)
    const actor = await requireOrganizationAdmin(tx, organizationId, actorId)
    const [member] = await tx.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId))).limit(1)
    if (!member) throw new GovernanceError('not_found')
    if ((member.role === 'owner' || role === 'owner') && actor.membership.role !== 'owner') throw new GovernanceError('access_denied')
    if (member.role === 'owner' && member.status === 'active' && role !== 'owner') {
      await assertOtherActiveOrganizationOwner(tx, organizationId, userId)
    }
    await tx.update(organizationMembers).set({ role, updatedAt: new Date() }).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.member_changed', targetId: userId, metadata: { role } })
  })
}

export async function renameOrganization(organizationId: string, actorId: string, input: unknown) {
  const { name } = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(input)
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, actorId)
    const [organization] = await tx.update(organizations).set({ name, updatedAt: new Date() }).where(eq(organizations.id, organizationId)).returning()
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.renamed', targetId: organizationId })
    return { organization }
  })
}

/** Existing accounts are explicitly selected by ID; neither an email match nor an Org role grants workspace access. */
export async function addOrganizationMember(organizationId: string, actorId: string, input: unknown) {
  const { userId, role } = z.object({ userId: z.string().min(1).max(200), role: z.enum(['owner', 'admin', 'member']).default('member') }).strict().parse(input)
  return workspaceDb.transaction(async tx => {
    await assertOrganizationAccountWritable(tx, userId)
    const actor = await requireOrganizationAdmin(tx, organizationId, actorId)
    if (role === 'owner' && actor.membership.role !== 'owner') throw new GovernanceError('access_denied')
    const { rows: [user] } = await pool.query<{ name: string; email: string }>('select name,email from "user" where id=$1', [userId])
    if (!user) throw new GovernanceError('not_found')
    const [member] = await tx.insert(organizationMembers).values({ organizationId, userId, role, ...user }).onConflictDoNothing().returning()
    if (!member) throw new GovernanceError('invalid_request')
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.member_changed', targetId: userId, metadata: { role, status: 'active' } })
    return { member }
  })
}

/** Directory reprovisioning may later create an ordinary Org member, but cannot restore this user's workspace grants or old Org role. */
export async function removeOrganizationMember(organizationId: string, actorId: string, userId: string) {
  z.string().min(1).max(200).parse(userId)
  const workspaceIds = await workspaceDb.transaction(async tx => {
    const ids = await getOrganizationWorkspaceIds(tx, organizationId)
    if (ids.length) await tx.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.id, ids)).orderBy(asc(workspaces.id)).for('update')
    const actor = await requireOrganizationAdmin(tx, organizationId, actorId)
    const [member] = await tx.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId))).limit(1)
    if (!member) throw new GovernanceError('not_found')
    if (member.role === 'owner') {
      if (actor.membership.role !== 'owner') throw new GovernanceError('access_denied')
      await assertOtherActiveOrganizationOwner(tx, organizationId, userId)
    }
    await tx.delete(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    if (ids.length) await tx.update(workspaceMembers).set({ status: 'suspended' }).where(and(inArray(workspaceMembers.workspaceId, ids), eq(workspaceMembers.userId, userId)))
    for (const id of ids) await enqueueMemberLifecycle(tx, id, userId, 'suspend')
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.member_removed', targetId: userId })
    return ids
  })
  await pool.query('update session set "enterpriseOrganizationId"=null,"enterpriseProviderId"=null,"enterpriseDirectoryUserId"=null,"enterpriseIdentityId"=null where "userId"=$1 and "enterpriseOrganizationId"=$2', [userId, organizationId])
  for (const id of workspaceIds) await drainMemberLifecycleOutbox(id, userId)
}

/** Delete is a tombstone: detach workspaces and revoke providers first; audit records remain governed by retention/legal hold. */
export async function archiveOrganization(organizationId: string, actorId: string) {
  return workspaceDb.transaction(async tx => {
    const { organization, membership } = await requireOrganizationAdmin(tx, organizationId, actorId, true)
    if (membership.role !== 'owner') throw new GovernanceError('access_denied')
    if (organization.archivedAt) return { archived: true }
    if ((await getOrganizationWorkspaceIds(tx, organizationId)).length) throw new GovernanceError('workspace_attached')
    const { rows } = await pool.query(`select 1 from enterprise_sso_provider where "organizationScopeId"=$1 and "domainVerified"
      union all select 1 from enterprise_scim_connection where "organizationId"=$1 and "revokedAt" is null limit 1`, [organizationId])
    if (rows.length) throw new GovernanceError('invalid_request')
    // This monotone APP barrier commits first. A workspace DB outage can only leave the Org blocked; retry finishes its tombstone.
    await pool.query(`insert into enterprise_org_policy ("organizationId","archivedAt") values ($1,now())
      on conflict ("organizationId") do update set "archivedAt"=coalesce(enterprise_org_policy."archivedAt",now())`, [organizationId])
    await tx.update(organizations).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(organizations.id, organizationId))
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.archived', targetId: organizationId })
    return { archived: true }
  })
}
