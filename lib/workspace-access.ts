import 'server-only'
import { cookies } from 'next/headers'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionErrorCode, ActionErrorParams } from '@/lib/action-result'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaces, workspaceMembers, workspaceInvitations } from '@/lib/db/workspace-schema'

export class WorkspaceError extends ActionFailureError {
  constructor(code: ActionErrorCode, params?: ActionErrorParams) {
    super(code, params)
    this.name = 'WorkspaceError'
  }
}
export type WorkspaceTransaction = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]

export async function requireWorkspace(tx: WorkspaceTransaction, workspaceId: string, userId: string, admin = false) {
  if (!z.uuid().safeParse(workspaceId).success) throw new WorkspaceError('validationGeneric')
  const [row] = await tx.select({ workspace: workspaces, membership: workspaceMembers }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaces.id, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .for('update').limit(1)
  if (!row || (admin && row.membership.role !== 'admin')) throw new WorkspaceError('workspaceAccessDenied')
  return row
}

export async function loadWorkspaceSettings(requestedId?: string) {
  const user = await requireUser()
  return workspaceDb.transaction(async tx => {
    const own = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.userId, user.id)).limit(1)
    if (!own.length) {
      const t = await getTranslations('Members')
      const defaultName = user.name ? t('defaultWorkspaceName', { name: user.name }) : t('myWorkspace')
      const [created] = await tx.insert(workspaces).values({ id: crypto.randomUUID(), userId: user.id, name: defaultName.slice(0, 120) }).onConflictDoNothing().returning({ id: workspaces.id })
      if (created) await tx.insert(workspaceMembers).values({ workspaceId: created.id, userId: user.id, email: user.email.toLowerCase(), name: user.name, role: 'admin' })
    }
    const choices = await tx.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaces.createdAt))
    const savedId = (await cookies()).get('orvilo-workspace')?.value
    const workspaceId = requestedId ?? choices.find(item => item.id === savedId)?.id ?? choices[0]?.id
    if (!workspaceId) throw new WorkspaceError('workspaceNotFound')
    const { workspace, membership } = await requireWorkspace(tx, workspaceId, user.id)
    const members = await tx.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email, role: workspaceMembers.role, status: workspaceMembers.status, createdAt: workspaceMembers.createdAt })
      .from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)).orderBy(asc(workspaceMembers.createdAt))
    const invitations = membership.role === 'admin' ? await tx.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, createdAt: workspaceInvitations.createdAt, expiresAt: workspaceInvitations.expiresAt })
      .from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.status, 'pending'))).orderBy(asc(workspaceInvitations.createdAt)) : []
    // Auth profiles live in a separate database; only read IDs from this authorized workspace.
    const profiles = members.length ? await db.select({ id: users.id, image: users.image }).from(users)
      .where(inArray(users.id, members.map(member => member.userId))) : []
    const images = new Map(profiles.map(profile => [profile.id, profile.image]))
    return {
      workspace: { id: workspace.id, name: workspace.name }, choices, currentUserId: user.id, role: membership.role,
      currentUser: { email: user.email, image: user.image ?? null },
      members: members.map(member => ({ ...member, image: images.get(member.userId) ?? null, createdAt: member.createdAt.toISOString() })),
      invitations: invitations.map(invite => ({ ...invite, createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString() })),
    }
  })
}
export type WorkspaceSettings = Awaited<ReturnType<typeof loadWorkspaceSettings>>
