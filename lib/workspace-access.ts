import 'server-only'
import { cookies } from 'next/headers'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaces, workspaceMembers, workspaceInvitations } from '@/lib/db/workspace-schema'

export class WorkspaceError extends Error {}
export type WorkspaceTransaction = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]

export async function requireWorkspace(tx: WorkspaceTransaction, workspaceId: string, userId: string, admin = false) {
  z.uuid().parse(workspaceId)
  const [row] = await tx.select({ workspace: workspaces, membership: workspaceMembers }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaces.id, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .for('update').limit(1)
  if (!row || (admin && row.membership.role !== 'admin')) throw new WorkspaceError('没有管理此工作区的权限，或成员资格已被停用。')
  return row
}

export async function loadWorkspaceSettings(requestedId?: string) {
  const user = await requireUser()
  return workspaceDb.transaction(async tx => {
    const own = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.userId, user.id)).limit(1)
    if (!own.length) {
      const [created] = await tx.insert(workspaces).values({ id: crypto.randomUUID(), userId: user.id, name: `${user.name || '我的'}的工作区`.slice(0, 120) }).onConflictDoNothing().returning({ id: workspaces.id })
      if (created) await tx.insert(workspaceMembers).values({ workspaceId: created.id, userId: user.id, email: user.email.toLowerCase(), name: user.name, role: 'admin' })
    }
    const choices = await tx.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaces.createdAt))
    const savedId = (await cookies()).get('orvilo-workspace')?.value
    const workspaceId = requestedId ?? choices.find(item => item.id === savedId)?.id ?? choices[0]?.id
    if (!workspaceId) throw new WorkspaceError('没有可访问的工作区。')
    const { workspace, membership } = await requireWorkspace(tx, workspaceId, user.id)
    const members = await tx.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email, role: workspaceMembers.role, status: workspaceMembers.status, createdAt: workspaceMembers.createdAt })
      .from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)).orderBy(asc(workspaceMembers.createdAt))
    const invitations = membership.role === 'admin' ? await tx.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, createdAt: workspaceInvitations.createdAt, expiresAt: workspaceInvitations.expiresAt })
      .from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.status, 'pending'))).orderBy(asc(workspaceInvitations.createdAt)) : []
    return {
      workspace: { id: workspace.id, name: workspace.name }, choices, currentUserId: user.id, role: membership.role,
      members: members.map(member => ({ ...member, createdAt: member.createdAt.toISOString() })),
      invitations: invitations.map(invite => ({ ...invite, createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString() })),
    }
  })
}
export type WorkspaceSettings = Awaited<ReturnType<typeof loadWorkspaceSettings>>
