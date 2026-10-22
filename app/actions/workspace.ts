'use server'

import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, ne } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaceInvitations, workspaces } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'

const roleSchema = z.enum(['admin', 'member'])
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/)
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export async function createWorkspaceInvitation(input: { workspaceId: string; emails: string[]; role: string }): Promise<ActionResult<{ email: string; path: string }[]>> {
  return runAction(async () => {
    const user = await requireUser()
    const parsedRole = roleSchema.safeParse(input.role)
    if (!parsedRole.success) return { error: 'validationGeneric' }
    const parsedEmails = z.array(z.email().max(254)).min(1).max(20).safeParse(input.emails.map(email => email.trim().toLowerCase()))
    if (!parsedEmails.success) throw new WorkspaceError('inviteInvalidEmails')
    const role = parsedRole.data
    const emails = [...new Set(parsedEmails.data)]
    return workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, input.workspaceId, user.id, true)
      const members = await tx.select({ email: workspaceMembers.email }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, input.workspaceId))
      if (emails.some(email => members.some(member => member.email.toLowerCase() === email))) throw new WorkspaceError('workspaceMemberExists')
      const links: { email: string; path: string }[] = []
      for (const email of emails) {
        const token = randomBytes(32).toString('hex')
        await tx.insert(workspaceInvitations).values({ id: crypto.randomUUID(), workspaceId: input.workspaceId, userId: user.id, email, role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 86400000) })
          .onConflictDoUpdate({ target: [workspaceInvitations.workspaceId, workspaceInvitations.email], set: { userId: user.id, role, tokenHash: hashToken(token), status: 'pending', expiresAt: new Date(Date.now() + 7 * 86400000), createdAt: new Date() } })
        links.push({ email, path: `/invite/${token}` })
      }
      return links
    })
  })
}

export async function updateWorkspaceMember(input: { workspaceId: string; userId: string; role: string; status: string }): Promise<ActionResult<{ updated: true }>> {
  return runAction(async () => {
    const user = await requireUser()
    const parsedRole = roleSchema.safeParse(input.role)
    const parsedStatus = z.enum(['active', 'suspended']).safeParse(input.status)
    if (!parsedRole.success || !parsedStatus.success || !z.string().min(1).max(200).safeParse(input.userId).success) return { error: 'validationGeneric' }
    const role = parsedRole.data
    const status = parsedStatus.data
    return workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, input.workspaceId, user.id, true)
      const [target] = await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))).limit(1)
      if (!target) throw new WorkspaceError('workspaceMemberNotFound')
      if (target.role === 'admin' && target.status === 'active' && (role !== 'admin' || status !== 'active')) {
        const others = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), ne(workspaceMembers.userId, input.userId), eq(workspaceMembers.role, 'admin'), eq(workspaceMembers.status, 'active'))).limit(1)
        if (!others.length) throw new WorkspaceError('workspaceLastAdmin')
      }
      await tx.update(workspaceMembers).set({ role, status }).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId)))
      return { updated: true as const }
    })
  })
}

export async function revokeWorkspaceInvitation(workspaceId: string, invitationId: string): Promise<ActionResult<{ revoked: true }>> {
  return runAction(async () => {
    const user = await requireUser()
    if (!z.uuid().safeParse(invitationId).success) return { error: 'validationGeneric' }
    return workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, workspaceId, user.id, true)
      await tx.update(workspaceInvitations).set({ status: 'revoked' }).where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.id, invitationId), eq(workspaceInvitations.status, 'pending')))
      return { revoked: true as const }
    })
  })
}

export async function acceptWorkspaceInvitation(token: string): Promise<ActionResult<{ workspaceId: string }>> {
  return runAction(async () => {
    const user = await requireUser()
    if (!tokenSchema.safeParse(token).success) return { error: 'validationGeneric' }
    const workspaceId = await workspaceDb.transaction(async tx => {
      const [candidate] = await tx.select({ workspaceId: workspaceInvitations.workspaceId }).from(workspaceInvitations).where(and(eq(workspaceInvitations.tokenHash, hashToken(token)), eq(workspaceInvitations.email, user.email.toLowerCase()), eq(workspaceInvitations.status, 'pending'), gt(workspaceInvitations.expiresAt, new Date()))).limit(1)
      if (!candidate) throw new WorkspaceError('inviteInvalid')
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, candidate.workspaceId)).for('update')
      const [invitation] = await tx.select({ id: workspaceInvitations.id, role: workspaceInvitations.role }).from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, candidate.workspaceId), eq(workspaceInvitations.tokenHash, hashToken(token)), eq(workspaceInvitations.email, user.email.toLowerCase()), eq(workspaceInvitations.status, 'pending'), gt(workspaceInvitations.expiresAt, new Date()))).for('update').limit(1)
      if (!invitation) throw new WorkspaceError('inviteExpired')
      const [existing] = await tx.select({ status: workspaceMembers.status }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, candidate.workspaceId), eq(workspaceMembers.userId, user.id))).limit(1)
      if (existing?.status === 'suspended') throw new WorkspaceError('workspaceMembershipSuspended')
      if (!existing) await tx.insert(workspaceMembers).values({ workspaceId: candidate.workspaceId, userId: user.id, name: user.name, email: user.email.toLowerCase(), role: invitation.role })
      await tx.update(workspaceInvitations).set({ status: 'accepted' }).where(and(eq(workspaceInvitations.id, invitation.id), eq(workspaceInvitations.workspaceId, candidate.workspaceId), eq(workspaceInvitations.email, user.email.toLowerCase())))
      return candidate.workspaceId
    })
    ;(await cookies()).set('mikka-workspace', workspaceId, { httpOnly: true, sameSite: process.env.NODE_ENV === 'development' ? 'none' : 'lax', secure: true, path: '/', maxAge: 31536000 })
    return { workspaceId }
  })
}
