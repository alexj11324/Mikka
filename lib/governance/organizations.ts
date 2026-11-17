import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNotNull, isNull, inArray, or, getTableColumns } from 'drizzle-orm'
import { z } from 'zod'
import { organizationAuditEvents, organizationBillingAccounts, organizationEntitlements, organizationInvitations, organizationMembers, organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { requireWorkspace, type WorkspaceTransaction } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { invalidateTaskWorkspaceOrganization } from '@/lib/task-workspace'
import { enqueueOrganizationAudit } from './audit'
import { activeHumanSeats, lockWorkspaceEntitlements } from './entitlements'
import { GovernanceError } from './errors'
import { parseWorkspaceIcon } from '@/lib/workspace-admin/icon'
import { assertOrganizationAccountWritable, assertOtherActiveOrganizationOwner } from './organization-ownership'
import { pool } from '@/lib/db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { enqueueMemberLifecycle, drainMemberLifecycleOutbox } from './member-outbox'
import { fenceWorkspaceLive, markWorkspaceLiveBinding, retireWorkspaceLiveBinding } from '../enterprise/live-authority'

const { icon: organizationIcon, ...organizationIdentity } = getTableColumns(organizations)

export async function requireOrganizationAdmin(tx: WorkspaceTransaction, organizationId: string, userId: string, includeArchived = false, withIcon = false) {
  z.uuid().parse(organizationId)
  // The organization row serializes ownership edits; callers touching a workspace lock it first.
  const [organization] = await tx.select({ ...organizationIdentity, ...(withIcon ? { icon: organizationIcon } : {}) }).from(organizations).where(eq(organizations.id, organizationId)).for('update').limit(1)
  const [membership] = await tx.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active'))).limit(1)
  if (!organization || (!includeArchived && organization.archivedAt) || !membership || membership.role === 'member') throw new GovernanceError('access_denied')
  return { organization, membership }
}

export async function getOrganizationWorkspaceIds(tx: WorkspaceTransaction, organizationId: string) {
  const rows = await tx.select({ workspaceId: organizationWorkspaces.workspaceId }).from(organizationWorkspaces).where(eq(organizationWorkspaces.organizationId, organizationId)).orderBy(asc(organizationWorkspaces.workspaceId))
  return rows.map(row => row.workspaceId)
}

const organizationDirectoryFields = {
  id: organizations.id,
  name: organizations.name,
  createdAt: organizations.createdAt,
  updatedAt: organizations.updatedAt,
}

export async function listOrganizations(userId: string, organizationId?: string) {
  return workspaceDb.select({ ...organizationDirectoryFields, role: organizationMembers.role }).from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active'), isNull(organizations.archivedAt),
      organizationId === undefined ? undefined : eq(organizations.id, organizationId))).orderBy(asc(organizations.createdAt))
}

/** Only a current owner may see the retained name after archiving. */
export async function listArchivedOrganizations(userId: string) {
  return workspaceDb.select({ id: organizations.id, name: organizations.name }).from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active'),
      eq(organizationMembers.role, 'owner'), isNotNull(organizations.archivedAt)))
    .orderBy(desc(organizations.archivedAt), asc(organizations.id))
}

export async function createOrganization(user: { id: string; name: string; email: string }, input: unknown) {
  const { name } = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(input)
  return workspaceDb.transaction(async tx => {
    await assertOrganizationAccountWritable(tx, user.id)
    const id = randomUUID()
    const [organization] = await tx.insert(organizations).values({ id, name, createdBy: user.id })
      .returning(organizationDirectoryFields)
    await tx.insert(organizationMembers).values({ organizationId: id, userId: user.id, role: 'owner', name: user.name, email: user.email.toLowerCase() })
    await tx.insert(organizationEntitlements).values({ organizationId: id })
    await enqueueOrganizationAudit(tx, { organizationId: id, actorId: user.id, action: 'organization.created' })
    return { ...organization, role: 'owner' as const }
  })
}

async function organizationMemberRows(tx: WorkspaceTransaction, organizationId: string, includeDisabled: boolean) {
  const members = await tx.select().from(organizationMembers).where(and(
    eq(organizationMembers.organizationId, organizationId),
    includeDisabled ? undefined : eq(organizationMembers.status, 'active'),
  )).orderBy(asc(organizationMembers.createdAt), asc(organizationMembers.userId))
  // Auth profiles live in the application database. Restrict the lookup to this authorized roster.
  const ids = members.map(member => member.userId)
  const pictures = ids.length ? (await pool.query<{ id: string; image: string | null }>(
    'select id, image from "user" where id=any($1::text[])', [ids])).rows : []
  const images = new Map(pictures.map(profile => [profile.id, profile.image]))
  return members.map(member => ({ ...member, image: images.get(member.userId) ?? null }))
}

export async function listOrganizationMembers(organizationId: string, actorId: string, includeDisabled: boolean) {
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, actorId)
    return { members: await organizationMemberRows(tx, organizationId, includeDisabled) }
  })
}

export async function organizationSummary(organizationId: string, userId: string) {
  return workspaceDb.transaction(async tx => {
    const { organization, membership } = await requireOrganizationAdmin(tx, organizationId, userId, false, true)
    const members = await organizationMemberRows(tx, organizationId, true)
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
    if (member.role === role) return
    if (member.role === 'owner' && member.status === 'active' && role !== 'owner') {
      await assertOtherActiveOrganizationOwner(tx, organizationId, userId)
    }
    await tx.update(organizationMembers).set({ role, updatedAt: new Date() }).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.member_changed', targetId: userId, metadata: { role } })
  })
}

const organizationProfile = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  icon: z.string().nullable().optional(),
}).strict().refine(input => input.name !== undefined || input.icon !== undefined)

export async function updateOrganizationProfile(organizationId: string, actorId: string, input: unknown) {
  const { name, icon } = organizationProfile.parse(input)
  const parsedIcon = icon === undefined ? undefined : parseWorkspaceIcon(icon)
  if (parsedIcon === false) throw new GovernanceError('invalid_request')
  return workspaceDb.transaction(async tx => {
    const { organization: current } = await requireOrganizationAdmin(tx, organizationId, actorId, false, true)
    const rename = name !== undefined && name !== current.name
    const changeIcon = parsedIcon !== undefined && parsedIcon !== current.icon
    if (!rename && !changeIcon) return { organization: current }
    const [organization] = await tx.update(organizations).set({ name, icon: parsedIcon, updatedAt: new Date() })
      .where(eq(organizations.id, organizationId)).returning()
    if (rename) await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.renamed', targetId: organizationId })
    if (changeIcon) await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.icon_changed', targetId: organizationId })
    return { organization }
  })
}

/** Existing callers update only the organization's name. */
export async function renameOrganization(organizationId: string, actorId: string, input: unknown) {
  const { name } = z.object({ name: z.string() }).strict().parse(input)
  return updateOrganizationProfile(organizationId, actorId, { name })
}

const organizationMemberRole = z.enum(['owner', 'admin', 'member'])
const organizationMemberUserId = z.string().min(1).max(200)
const admissionInput = z.object({ userId: organizationMemberUserId, role: organizationMemberRole.default('member') }).strict()
const restorationInput = z.object({ accessLevel: organizationMemberRole }).strict()

/** Existing accounts are explicitly selected by ID; neither an email match nor an Org role grants workspace access. */
export async function addOrganizationMember(organizationId: string, actorId: string, input: unknown) {
  const { member } = await admitOrganizationMember(organizationId, actorId, admissionInput.parse(input), 'add')
  return { member }
}

export async function restoreOrganizationMember(organizationId: string, actorId: string, userId: string, input: unknown) {
  const { accessLevel } = restorationInput.parse(input)
  const { member, image } = await admitOrganizationMember(organizationId, actorId, {
    userId: organizationMemberUserId.parse(userId), role: accessLevel,
  }, 'restore')
  return {
    userId: member.userId, email: member.email, firstName: null, lastName: null, imageUrl: image,
    accessLevel: member.role, disabled: member.status !== 'active', createdAt: member.createdAt, githubLogin: null,
  }
}

async function admitOrganizationMember(organizationId: string, actorId: string, { userId, role }: z.output<typeof admissionInput>, operation: 'add' | 'restore') {
  return workspaceDb.transaction(async tx => {
    await assertOrganizationAccountWritable(tx, userId)
    const actor = await requireOrganizationAdmin(tx, organizationId, actorId)
    if (role === 'owner' && (operation === 'restore' || actor.membership.role !== 'owner')) throw new GovernanceError('access_denied')
    if (operation === 'restore') {
      // A removal deletes the membership row. Only a retained removal for this
      // exact Organization and identity establishes eligibility for restoration.
      const [removal] = await tx.select({ id: organizationAuditEvents.id }).from(organizationAuditEvents).where(and(
        eq(organizationAuditEvents.organizationId, organizationId), eq(organizationAuditEvents.targetId, userId),
        eq(organizationAuditEvents.action, 'organization.member_removed'),
      )).limit(1)
      if (!removal) throw new GovernanceError('invalid_request')
      // A linked directory owns its subject's lifecycle, including delayed
      // suspension delivery. Manual readmission cannot take over that subject.
      const managed = await pool.query('select 1 from enterprise_scim_user where "organizationId"=$1 and "userId"=$2 limit 1', [organizationId, userId])
      if (managed.rowCount) throw new GovernanceError('access_denied')
    }
    const { rows: [user] } = await pool.query<{ name: string; email: string; image: string | null }>('select name,email,image from "user" where id=$1', [userId])
    if (!user) throw new GovernanceError(operation === 'restore' ? 'invalid_request' : 'not_found')
    const [member] = await tx.insert(organizationMembers).values({ organizationId, userId, role, name: user.name, email: user.email }).onConflictDoNothing().returning()
    if (!member) {
      const [existing] = await tx.select().from(organizationMembers).where(and(
        eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId),
        eq(organizationMembers.role, role), eq(organizationMembers.status, 'active'),
      )).for('share').limit(1)
      if (!existing) throw new GovernanceError('invalid_request')
      return { member: existing, image: user.image }
    }
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.member_changed', targetId: userId, metadata: { role, status: 'active' } })
    return { member, image: user.image }
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
    // A departed member's outstanding links cannot continue admitting people after revocation.
    // Also revoke any pending link addressed to the removed identity, so a deleted membership
    // cannot be restored by presenting an old bearer.
    await tx.update(organizationInvitations).set({ status: 'revoked', updatedAt: new Date() }).where(and(
      eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.status, 'pending'),
      or(eq(organizationInvitations.createdBy, userId), eq(organizationInvitations.email, member.email.toLowerCase()))))
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
