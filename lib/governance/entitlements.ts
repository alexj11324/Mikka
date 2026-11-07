import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { organizations, organizationEntitlements, organizationMembers, organizationWorkspaces } from '@/lib/db/governance-schema'
import { workspaceEntitlements } from '@/lib/db/team-entitlements-schema'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { deploymentMode } from './edition'
import { GovernanceError } from './errors'
import { resolveEntitlements, seatAdmissionAllowed, type DeploymentMode, type GovernanceFeature } from './policy'

/** Lock order for every admission/link/plan write is workspace -> organization. */
export async function lockWorkspaceEntitlements(tx: WorkspaceTransaction, workspaceId: string, mode: DeploymentMode = deploymentMode()) {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for('update').limit(1)
  if (!workspace) throw new GovernanceError('not_found')
  const [link] = await tx.select().from(organizationWorkspaces).where(eq(organizationWorkspaces.workspaceId, workspaceId)).limit(1)
  const organizationId = link?.organizationId ?? null
  if (organizationId) {
    const [organization] = await tx.select({ archivedAt: organizations.archivedAt }).from(organizations).where(eq(organizations.id, organizationId)).for('update')
    if (!organization || organization.archivedAt) throw new GovernanceError('access_denied')
  }
  const [grant] = organizationId
    ? await tx.select().from(organizationEntitlements).where(eq(organizationEntitlements.organizationId, organizationId)).limit(1)
    : await tx.select().from(workspaceEntitlements).where(eq(workspaceEntitlements.workspaceId, workspaceId)).limit(1)
  const entitlements = resolveEntitlements({ mode, kind: workspace.kind, grant })
  return { workspace, organizationId, entitlements }
}

/** Only human identities occupy workspaceMembers; machines/Bots/invitations use other tables. */
export async function activeHumanSeats(tx: WorkspaceTransaction, workspaceId: string, organizationId: string | null) {
  const rows = organizationId
    ? await tx.selectDistinct({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .innerJoin(organizationWorkspaces, eq(organizationWorkspaces.workspaceId, workspaceMembers.workspaceId))
      .where(and(eq(organizationWorkspaces.organizationId, organizationId), eq(workspaceMembers.status, 'active')))
    : await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active')))
  return rows.map(row => row.userId)
}

/** Caller must hold this transaction until its insert/reactivation commits. */
export async function assertActiveHumanAdmission(tx: WorkspaceTransaction, workspaceId: string, userId: string, mode?: DeploymentMode) {
  const scope = await lockWorkspaceEntitlements(tx, workspaceId, mode)
  if (scope.organizationId) {
    const [member] = await tx.select({ status: organizationMembers.status }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, scope.organizationId), eq(organizationMembers.userId, userId))).limit(1)
    if (member?.status === 'suspended') throw new GovernanceError('access_denied')
  }
  const seats = await activeHumanSeats(tx, workspaceId, scope.organizationId)
  if (!seatAdmissionAllowed({ current: seats.length, limit: scope.entitlements.activeHumanLimit, alreadyActive: seats.includes(userId) })) throw new GovernanceError('seat_limit')
  return scope
}

export async function requireGovernanceFeature(tx: WorkspaceTransaction, workspaceId: string, feature: GovernanceFeature) {
  const scope = await lockWorkspaceEntitlements(tx, workspaceId)
  if (!scope.entitlements[feature]) throw new GovernanceError('feature_unavailable')
  return scope
}

export async function workspaceGovernanceSummary(tx: WorkspaceTransaction, workspaceId: string) {
  const scope = await lockWorkspaceEntitlements(tx, workspaceId)
  const activeHumans = (await activeHumanSeats(tx, workspaceId, scope.organizationId)).length
  const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active')))
  return { organizationId: scope.organizationId, ...scope.entitlements, activeHumans, workspaceActiveHumans: count,
    overLimit: scope.entitlements.activeHumanLimit !== null && activeHumans > scope.entitlements.activeHumanLimit }
}
