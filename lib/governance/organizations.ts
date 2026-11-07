import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { organizationAuditEvents, organizationEntitlements, organizationMembers, organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { requireWorkspace, type WorkspaceTransaction } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { enqueueOrganizationAudit } from './audit'
import { activeHumanSeats, lockWorkspaceEntitlements } from './entitlements'
import { GovernanceError } from './errors'

export async function requireOrganizationAdmin(tx: WorkspaceTransaction, organizationId: string, userId: string) {
  z.uuid().parse(organizationId)
  // The organization row serializes ownership edits; callers touching a workspace lock it first.
  const [organization] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).for('update').limit(1)
  const [membership] = await tx.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active'))).limit(1)
  if (!organization || !membership || membership.role === 'member') throw new GovernanceError('access_denied')
  return { organization, membership }
}

export async function getOrganizationWorkspaceIds(tx: WorkspaceTransaction, organizationId: string) {
  const rows = await tx.select({ workspaceId: organizationWorkspaces.workspaceId }).from(organizationWorkspaces).where(eq(organizationWorkspaces.organizationId, organizationId)).orderBy(asc(organizationWorkspaces.workspaceId))
  return rows.map(row => row.workspaceId)
}

export async function listOrganizations(userId: string) {
  return workspaceDb.select({ id: organizations.id, name: organizations.name, role: organizationMembers.role }).from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active'))).orderBy(asc(organizations.createdAt))
}

export async function createOrganization(user: { id: string; name: string; email: string }, input: unknown) {
  const { name } = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(input)
  return workspaceDb.transaction(async tx => {
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
  return workspaceDb.transaction(async tx => {
    const { workspace } = await requireWorkspace(tx, z.uuid().parse(workspaceId), userId, true)
    if (workspace.kind === 'personal') throw new GovernanceError('personal_workspace')
    await requireOrganizationAdmin(tx, organizationId, userId)
    const [existing] = await tx.select().from(organizationWorkspaces).where(eq(organizationWorkspaces.workspaceId, workspaceId)).limit(1)
    if (existing) {
      if (existing.organizationId !== organizationId) throw new GovernanceError('workspace_attached')
      return
    }
    await tx.insert(organizationWorkspaces).values({ workspaceId, organizationId })
    const scope = await lockWorkspaceEntitlements(tx, workspaceId)
    const seats = await activeHumanSeats(tx, workspaceId, organizationId)
    if (scope.entitlements.activeHumanLimit !== null && seats.length > scope.entitlements.activeHumanLimit) throw new GovernanceError('seat_limit')
    await enqueueOrganizationAudit(tx, { organizationId, actorId: userId, action: 'organization.workspace_attached', targetId: workspaceId })
  })
}

export async function detachOrganizationWorkspace(organizationId: string, workspaceId: string, userId: string) {
  await workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, z.uuid().parse(workspaceId), userId, true)
    await requireOrganizationAdmin(tx, organizationId, userId)
    const rows = await tx.delete(organizationWorkspaces).where(and(eq(organizationWorkspaces.workspaceId, workspaceId), eq(organizationWorkspaces.organizationId, organizationId))).returning()
    if (!rows.length) throw new GovernanceError('not_found')
    // Detaching or downgrading never destroys members. Further admissions enforce the resulting cap.
    await enqueueOrganizationAudit(tx, { organizationId, actorId: userId, action: 'organization.workspace_detached', targetId: workspaceId })
  })
}

export async function updateOrganizationMember(organizationId: string, actorId: string, input: unknown) {
  const { userId, role } = z.object({ userId: z.string().min(1).max(200), role: z.enum(['owner', 'admin', 'member']) }).strict().parse(input)
  await workspaceDb.transaction(async tx => {
    const actor = await requireOrganizationAdmin(tx, organizationId, actorId)
    const [member] = await tx.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId))).limit(1)
    if (!member) throw new GovernanceError('not_found')
    if ((member.role === 'owner' || role === 'owner') && actor.membership.role !== 'owner') throw new GovernanceError('access_denied')
    if (member.role === 'owner' && member.status === 'active' && role !== 'owner') {
      const owners = await tx.select({ userId: organizationMembers.userId }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, 'owner'), eq(organizationMembers.status, 'active'), ne(organizationMembers.userId, userId))).limit(1)
      if (!owners.length) throw new GovernanceError('last_owner')
    }
    await tx.update(organizationMembers).set({ role, updatedAt: new Date() }).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.member_changed', targetId: userId, metadata: { role } })
  })
}
