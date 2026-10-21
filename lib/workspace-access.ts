import 'server-only'
import { createHash } from 'node:crypto'
import { cookies } from 'next/headers'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
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

export async function loadWorkspaceSettings(requestedId?: string, authenticatedUser?: Awaited<ReturnType<typeof requireUser>>) {
  const user = authenticatedUser ?? await requireUser()
  const listChoices = () => workspaceDb.select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaces.createdAt))
  let choices = await listChoices()
  if (!choices.length) {
    await workspaceDb.transaction(async tx => {
      const [own] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.userId, user.id)).limit(1)
      if (own) throw new WorkspaceError('没有可访问的工作区，请联系管理员。')
      // A stable bootstrap ID prevents concurrent first loads from creating duplicate defaults.
      const hash = createHash('sha256').update(`orvilo-default:${user.id}`).digest('hex')
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
      await tx.insert(workspaces).values({ id, userId: user.id, name: `${user.name || '我的'}的工作区`.slice(0, 120) }).onConflictDoNothing()
      await tx.insert(workspaceMembers).values({ workspaceId: id, userId: user.id, email: user.email.toLowerCase(), name: user.name, role: 'admin' }).onConflictDoNothing()
    })
    choices = await listChoices()
  }
  const savedId = (await cookies()).get('orvilo-workspace')?.value
  const workspaceId = requestedId ?? choices.find(item => item.id === savedId)?.id ?? choices[0]?.id
  const workspace = choices.find(item => item.id === workspaceId)
  if (!workspace) throw new WorkspaceError('没有查看此工作区的权限，或成员资格已被停用。')
  const allowed = workspaceDb.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active')))
  const administered = workspaceDb.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active'), eq(workspaceMembers.role, 'admin')))
  const [members, invitations] = await Promise.all([
    workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email, role: workspaceMembers.role, status: workspaceMembers.status, createdAt: workspaceMembers.createdAt })
      .from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), inArray(workspaceMembers.workspaceId, allowed))).orderBy(asc(workspaceMembers.createdAt)),
    workspace.role === 'admin' ? workspaceDb.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, createdAt: workspaceInvitations.createdAt, expiresAt: workspaceInvitations.expiresAt })
      .from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, workspace.id), inArray(workspaceInvitations.workspaceId, administered), eq(workspaceInvitations.status, 'pending'))).orderBy(asc(workspaceInvitations.createdAt)) : Promise.resolve([]),
  ])
  const snapshot = {
    workspace: { id: workspace.id, name: workspace.name }, choices, currentUserId: user.id, role: workspace.role,
    currentUser: { email: user.email, image: user.image ?? null }, members,
    invitations: invitations.map(invite => ({ ...invite, createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString() })),
  }
  // Only read profile IDs from the authorized workspace result.
  const otherMemberIds = snapshot.members.filter(member => member.userId !== user.id).map(member => member.userId)
  const profiles = otherMemberIds.length ? await db.select({ id: users.id, image: users.image }).from(users)
    .where(inArray(users.id, otherMemberIds)) : []
  const images = new Map(profiles.map(profile => [profile.id, profile.image]))
  images.set(user.id, user.image ?? null)
  return {
    ...snapshot,
    members: snapshot.members.map(member => ({ ...member, image: images.get(member.userId) ?? null, createdAt: member.createdAt.toISOString() })),
  }
}
export type WorkspaceSettings = Awaited<ReturnType<typeof loadWorkspaceSettings>>
