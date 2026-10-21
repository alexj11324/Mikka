'use server'

import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, ne } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaceInvitations, workspaces } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'

const roleSchema = z.enum(['admin', 'member'])
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/)
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

async function result<T>(operation: () => Promise<T>) {
  try { return { ok: true as const, data: await operation() } }
  catch (error) {
    if (error instanceof WorkspaceError) return { ok: false as const, error: error.message }
    if (error instanceof z.ZodError) return { ok: false as const, error: '请检查邮箱、角色或操作参数。' }
    console.error('Workspace operation failed', error instanceof Error ? error.name : 'UnknownError')
    return { ok: false as const, error: '操作未完成，请刷新页面或稍后重试。' }
  }
}

async function saveWorkspaceSelection(workspaceId: string) {
  ;(await cookies()).set('orvilo-workspace', workspaceId, { httpOnly: true, sameSite: process.env.NODE_ENV === 'development' ? 'none' : 'lax', secure: true, path: '/', maxAge: 31536000 })
}

export async function switchWorkspace(workspaceId: string) {
  return result(async () => {
    const user = await requireUser()
    z.uuid().parse(workspaceId)
    const [membership] = await workspaceDb.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active'))).limit(1)
    if (!membership) throw new WorkspaceError('没有访问此工作区的权限。')
    await saveWorkspaceSelection(workspaceId)
    return { workspaceId }
  })
}

export async function createWorkspace(name: string) {
  return result(async () => {
    const user = await requireUser()
    const parsedName = z.string().trim().min(1).max(120).parse(name)
    const workspaceId = crypto.randomUUID()
    await workspaceDb.transaction(async tx => {
      await tx.insert(workspaces).values({ id: workspaceId, userId: user.id, name: parsedName })
      await tx.insert(workspaceMembers).values({ workspaceId, userId: user.id, name: user.name, email: user.email.toLowerCase(), role: 'admin' })
    })
    await saveWorkspaceSelection(workspaceId)
    return { workspaceId }
  })
}

export async function createWorkspaceInvitation(input: { workspaceId: string; emails: string[]; role: string }) {
  return result(async () => {
    const user = await requireUser()
    const role = roleSchema.parse(input.role)
    const emails = [...new Set(z.array(z.email().max(254)).min(1).max(20).parse(input.emails.map(email => email.trim().toLowerCase())))]
    return workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, input.workspaceId, user.id, true)
      const members = await tx.select({ email: workspaceMembers.email }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, input.workspaceId))
      if (emails.some(email => members.some(member => member.email.toLowerCase() === email))) throw new WorkspaceError('其中一个邮箱已经是工作区成员，请在成员列表中管理或恢复。')
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

export async function updateWorkspaceMember(input: { workspaceId: string; userId: string; role: string; status: string }) {
  return result(async () => {
    const user = await requireUser()
    const role = roleSchema.parse(input.role)
    const status = z.enum(['active', 'suspended']).parse(input.status)
    z.string().min(1).max(200).parse(input.userId)
    await workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, input.workspaceId, user.id, true)
      const [target] = await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))).limit(1)
      if (!target) throw new WorkspaceError('成员不存在。')
      if (target.role === 'admin' && target.status === 'active' && (role !== 'admin' || status !== 'active')) {
        const others = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), ne(workspaceMembers.userId, input.userId), eq(workspaceMembers.role, 'admin'), eq(workspaceMembers.status, 'active'))).limit(1)
        if (!others.length) throw new WorkspaceError('工作区必须保留至少一位启用中的管理员。')
      }
      await tx.update(workspaceMembers).set({ role, status }).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId)))
    })
  })
}

export async function revokeWorkspaceInvitation(workspaceId: string, invitationId: string) {
  return result(async () => {
    const user = await requireUser()
    z.uuid().parse(invitationId)
    await workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, workspaceId, user.id, true)
      await tx.update(workspaceInvitations).set({ status: 'revoked' }).where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.id, invitationId), eq(workspaceInvitations.status, 'pending')))
    })
  })
}

export async function acceptWorkspaceInvitation(token: string) {
  return result(async () => {
    const user = await requireUser()
    tokenSchema.parse(token)
    const workspaceId = await workspaceDb.transaction(async tx => {
      const [candidate] = await tx.select({ workspaceId: workspaceInvitations.workspaceId }).from(workspaceInvitations).where(and(eq(workspaceInvitations.tokenHash, hashToken(token)), eq(workspaceInvitations.email, user.email.toLowerCase()), eq(workspaceInvitations.status, 'pending'), gt(workspaceInvitations.expiresAt, new Date()))).limit(1)
      if (!candidate) throw new WorkspaceError('邀请无效、已过期，或当前登录邮箱不匹配。')
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, candidate.workspaceId)).for('update')
      const [invitation] = await tx.select({ id: workspaceInvitations.id, role: workspaceInvitations.role }).from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, candidate.workspaceId), eq(workspaceInvitations.tokenHash, hashToken(token)), eq(workspaceInvitations.email, user.email.toLowerCase()), eq(workspaceInvitations.status, 'pending'), gt(workspaceInvitations.expiresAt, new Date()))).for('update').limit(1)
      if (!invitation) throw new WorkspaceError('邀请已失效，请向管理员索取新的链接。')
      const [existing] = await tx.select({ status: workspaceMembers.status }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, candidate.workspaceId), eq(workspaceMembers.userId, user.id))).limit(1)
      if (existing?.status === 'suspended') throw new WorkspaceError('成员资格已停用，请联系管理员恢复。')
      if (!existing) await tx.insert(workspaceMembers).values({ workspaceId: candidate.workspaceId, userId: user.id, name: user.name, email: user.email.toLowerCase(), role: invitation.role })
      await tx.update(workspaceInvitations).set({ status: 'accepted' }).where(and(eq(workspaceInvitations.id, invitation.id), eq(workspaceInvitations.workspaceId, candidate.workspaceId), eq(workspaceInvitations.email, user.email.toLowerCase())))
      return candidate.workspaceId
    })
    ;(await cookies()).set('orvilo-workspace', workspaceId, { httpOnly: true, sameSite: process.env.NODE_ENV === 'development' ? 'none' : 'lax', secure: true, path: '/', maxAge: 31536000 })
    return { workspaceId }
  })
}
