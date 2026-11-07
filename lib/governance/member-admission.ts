import 'server-only'
import { and, eq, gt } from 'drizzle-orm'
import { workspaceInvitations, workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { organizationMembers } from '@/lib/db/governance-schema'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { WorkspaceError } from '@/lib/workspace-error'
import { assertActiveHumanAdmission, lockWorkspaceEntitlements } from './entitlements'
import type { DeploymentMode } from './policy'
import { enqueueMemberLifecycle } from './member-outbox'

/** Called only with a server-authenticated user, inside the caller's audited transaction. */
export async function acceptHumanInvitation(tx: WorkspaceTransaction, user: { id: string; name: string; email: string }, tokenHash: string, mode?: DeploymentMode) {
  const where = and(eq(workspaceInvitations.tokenHash, tokenHash), eq(workspaceInvitations.email, user.email.toLowerCase()), eq(workspaceInvitations.status, 'pending'), gt(workspaceInvitations.expiresAt, new Date()))
  const [candidate] = await tx.select({ workspaceId: workspaceInvitations.workspaceId }).from(workspaceInvitations).where(where).limit(1)
  if (!candidate) throw new WorkspaceError('inviteInvalid')
  // The workspace lock precedes the invitation lock for every concurrent acceptance.
  const [target] = await tx.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, candidate.workspaceId)).for('update')
  if (!target || target.kind === 'personal') throw new WorkspaceError('inviteInvalid')
  const [invitation] = await tx.select({ id: workspaceInvitations.id, role: workspaceInvitations.role }).from(workspaceInvitations)
    .where(and(where, eq(workspaceInvitations.workspaceId, candidate.workspaceId))).for('update').limit(1)
  if (!invitation) throw new WorkspaceError('inviteExpired')
  const [existing] = await tx.select({ status: workspaceMembers.status }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, candidate.workspaceId), eq(workspaceMembers.userId, user.id))).limit(1)
  if (existing?.status === 'suspended') throw new WorkspaceError('workspaceMembershipSuspended')
  if (!existing) {
    const admission = await assertActiveHumanAdmission(tx, candidate.workspaceId, user.id, mode)
    await tx.insert(workspaceMembers).values({ workspaceId: candidate.workspaceId, userId: user.id, name: user.name, email: user.email.toLowerCase(), role: invitation.role })
    if (admission.organizationId) await tx.insert(organizationMembers).values({ organizationId: admission.organizationId, userId: user.id, name: user.name, email: user.email.toLowerCase(), role: 'member' }).onConflictDoNothing()
  }
  await tx.update(workspaceInvitations).set({ status: 'accepted' }).where(and(eq(workspaceInvitations.id, invitation.id), eq(workspaceInvitations.workspaceId, candidate.workspaceId)))
  return { workspaceId: candidate.workspaceId, role: invitation.role, joined: !existing }
}

/** Caller has already checked admin authority and the last-admin rule. */
export async function updateHumanMembership(tx: WorkspaceTransaction, input: { workspaceId: string; userId: string; role: 'admin' | 'member'; status: 'active' | 'suspended' }, mode?: DeploymentMode) {
  await lockWorkspaceEntitlements(tx, input.workspaceId, mode)
  const where = and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))
  const [member] = await tx.select({ status: workspaceMembers.status }).from(workspaceMembers).where(where).for('update').limit(1)
  if (!member) throw new WorkspaceError('workspaceMemberNotFound')
  if (member.status === 'suspended' && input.status === 'active') await assertActiveHumanAdmission(tx, input.workspaceId, input.userId, mode)
  await tx.update(workspaceMembers).set({ role: input.role, status: input.status }).where(where)
  if (member.status !== input.status) await enqueueMemberLifecycle(tx, input.workspaceId, input.userId, input.status === 'suspended' ? 'suspend' : 'restore')
}
