'use server'

import { getTranslations } from 'next-intl/server'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, ne } from 'drizzle-orm'
import { cookies, headers } from 'next/headers'
import { auth, type DeviceSessionSummary } from '@/lib/auth'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaceInvitations, workspaces } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { slugIsReserved } from '@/lib/workspace-admin/general'
import { releaseDepartingMember, restoreReturningMember, transferOnSuspend } from '@/lib/workspace-admin/members'
import { auditRequestContext } from '@/lib/audit/record'
import { enqueueWorkspaceAudit } from '@/lib/audit/delivery'

const roleSchema = z.enum(['admin', 'member'])
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/)
const workspaceSlug = z.string().trim().min(3).max(64).regex(/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/)
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

async function result<T>(operation: () => Promise<T>) {
  try {
    return { ok: true as const, data: await operation() }
  } catch (error) {
    const t = await getTranslations('Errors')
    if (error instanceof WorkspaceError) {
      return { ok: false as const, error: t.has(error.code as never) ? t(error.code as never) : error.message }
    }
    if (error instanceof z.ZodError) return { ok: false as const, error: t('validationGeneric') }
    console.error('Workspace operation failed', error instanceof Error ? error.name : 'UnknownError')
    return { ok: false as const, error: t('generic') }
  }
}

async function rememberWorkspace(workspaceId: string) {
  const cookieStore = await cookies()
  const options = { httpOnly: true, sameSite: process.env.NODE_ENV === 'development' ? 'none' as const : 'lax' as const, secure: true, path: '/', maxAge: 31536000 }
  cookieStore.set('mikka-workspace', workspaceId, options)
  cookieStore.set('mikka-workspace', workspaceId, options)
}

function createSlug(name: string) {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '')
  return slug.length >= 3 ? slug : `team-${crypto.randomUUID().slice(0, 8)}`
}

export async function createWorkspace(input: string | { name: string; slug: string }) {
  const i18nText = await getTranslations()
  return result(async () => {
    const user = await requireUser()
    const value = typeof input === 'string' ? { name: input, slug: createSlug(input) } : input
    const { name, slug } = z.object({ name: z.string().trim().min(1).max(120), slug: workspaceSlug }).parse(value)
    const workspaceId = crypto.randomUUID()
    await workspaceDb.transaction(async tx => {
      // An old slug of another workspace keeps redirecting there, so it cannot be reused.
      if (await slugIsReserved(tx, slug)) throw new WorkspaceError(i18nText('FeatureCopy.c_a56de3c3'))
      const [created] = await tx.insert(workspaces).values({ id: workspaceId, userId: user.id, name, slug }).onConflictDoNothing({ target: workspaces.slug }).returning({ id: workspaces.id })
      if (!created) throw new WorkspaceError(i18nText('FeatureCopy.c_a56de3c3'))
      await tx.insert(workspaceMembers).values({ workspaceId, userId: user.id, name: user.name, email: user.email.toLowerCase(), role: 'admin' })
    })
    await rememberWorkspace(workspaceId)
    return { workspaceId, slug }
  })
}

export async function switchWorkspace(input: string | { workspaceId?: string; accountId?: string }) {
  const i18nText = await getTranslations()
  return result(async () => {
    const user = await requireUser()
    const parsed = typeof input === 'string'
      ? { workspaceId: z.uuid().parse(input), accountId: user.id }
      : z.object({ workspaceId: z.uuid().optional(), accountId: z.string().min(1).max(200).optional() }).parse(input)
    const accountId = parsed.accountId ?? user.id
    const deviceSessions: DeviceSessionSummary[] = accountId === user.id ? [] : await auth.api.listDeviceSessions({ headers: await headers() })
    const deviceSession = deviceSessions.find(item => item.user.id === accountId)
    if (accountId !== user.id && !deviceSession) throw new WorkspaceError(i18nText('FeatureCopy.c_c2e795ad'))
    if (parsed.workspaceId) await workspaceDb.transaction(tx => requireWorkspace(tx, parsed.workspaceId!, accountId))
    if (deviceSession) await auth.api.setActiveSession({ body: { sessionToken: deviceSession.session.token }, headers: await headers() })
    if (parsed.workspaceId) await rememberWorkspace(parsed.workspaceId)
    else {
      const cookieStore = await cookies()
      cookieStore.delete('mikka-workspace')
      cookieStore.delete('mikka-workspace')
    }
    return { workspaceId: parsed.workspaceId }
  })
}

export async function createWorkspaceInvitation(input: { workspaceId: string; emails: string[]; role: string }) {
  return result(async () => {
    const user = await requireUser()
    const role = roleSchema.parse(input.role)
    const emails = [...new Set(z.array(z.email().max(254)).min(1).max(20).parse(input.emails.map(email => email.trim().toLowerCase())))]
    const request = auditRequestContext(await headers())
    return workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, input.workspaceId, user.id, true)
      const members = await tx.select({ email: workspaceMembers.email }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, input.workspaceId))
      if (emails.some(email => members.some(member => member.email.toLowerCase() === email))) throw new WorkspaceError('workspaceMemberExists')
      const links: { email: string; path: string }[] = []
      for (const email of emails) {
        const token = randomBytes(32).toString('hex')
        const tokenHash = hashToken(token)
        const expiresAt = new Date(Date.now() + 7 * 86400000)
        await tx.insert(workspaceInvitations).values({ id: crypto.randomUUID(), workspaceId: input.workspaceId, userId: user.id, email, role, tokenHash, expiresAt })
          .onConflictDoUpdate({ target: [workspaceInvitations.workspaceId, workspaceInvitations.email], set: { userId: user.id, role, tokenHash, status: 'pending', expiresAt, createdAt: new Date() } })
        await enqueueWorkspaceAudit(tx, { workspaceId: input.workspaceId, actor: { type: 'user', id: user.id, name: user.name }, action: 'member.invited', target: { type: 'invitation', label: email }, metadata: { role }, ...request })
        links.push({ email, path: `/invite/${token}` })
      }
      return links
    })
  })
}

/**
 * Role and status. When suspending, `transferTo` (optional, another active
 * member) takes over the suspended member's bots in this workspace.
 */
export async function updateWorkspaceMember(input: { workspaceId: string; userId: string; role: string; status: string; transferTo?: string }) {
  return result(async () => {
    const user = await requireUser()
    const role = roleSchema.parse(input.role)
    const status = z.enum(['active', 'suspended']).parse(input.status)
    z.string().min(1).max(200).parse(input.userId)
    if (input.transferTo !== undefined && status !== 'suspended') throw new WorkspaceError('validationGeneric')
    const request = auditRequestContext(await headers())
    const previous = await workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, input.workspaceId, user.id, true)
      const [target] = await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))).limit(1)
      if (!target) throw new WorkspaceError('workspaceMemberNotFound')
      if (target.role === 'admin' && target.status === 'active' && (role !== 'admin' || status !== 'active')) {
        const others = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), ne(workspaceMembers.userId, input.userId), eq(workspaceMembers.role, 'admin'), eq(workspaceMembers.status, 'active'))).limit(1)
        if (!others.length) throw new WorkspaceError('workspaceLastAdmin')
      }
      const base = { workspaceId: input.workspaceId, actor: { type: 'user' as const, id: user.id, name: user.name }, target: { type: 'member', id: target.userId, label: target.name || target.email }, ...request }
      if (target.role !== role) await enqueueWorkspaceAudit(tx, { ...base, action: 'member.role_changed', metadata: { oldRole: target.role, newRole: role } })
      if (target.status !== status) await enqueueWorkspaceAudit(tx, { ...base, action: status === 'suspended' ? 'member.suspended' : 'member.reactivated' })
      if (input.transferTo !== undefined) await transferOnSuspend(tx, input.workspaceId, input.userId, input.transferTo)
      await tx.update(workspaceMembers).set({ role, status }).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId)))
      return target.status
    })
    // §8.3: a suspended member's share and bots leave with them; reactivation brings their bots back.
    if (previous !== 'suspended' && status === 'suspended') await releaseDepartingMember(input.workspaceId, input.userId)
    if (previous === 'suspended' && status === 'active') await restoreReturningMember(input.workspaceId, input.userId)
  })
}

export async function revokeWorkspaceInvitation(workspaceId: string, invitationId: string) {
  return result(async () => {
    const user = await requireUser()
    z.uuid().parse(invitationId)
    const request = auditRequestContext(await headers())
    await workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, workspaceId, user.id, true)
      const [revoked] = await tx.update(workspaceInvitations).set({ status: 'revoked' }).where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.id, invitationId), eq(workspaceInvitations.status, 'pending'))).returning({ id: workspaceInvitations.id })
      if (revoked) await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'user', id: user.id, name: user.name }, action: 'member.invitation_revoked', target: { type: 'invitation', id: revoked.id }, ...request })
    })
  })
}

export async function acceptWorkspaceInvitation(token: string) {
  return result(async () => {
    const user = await requireUser()
    tokenSchema.parse(token)
    const request = auditRequestContext(await headers())
    const workspaceId = await workspaceDb.transaction(async tx => {
      const [candidate] = await tx.select({ workspaceId: workspaceInvitations.workspaceId }).from(workspaceInvitations).where(and(eq(workspaceInvitations.tokenHash, hashToken(token)), eq(workspaceInvitations.email, user.email.toLowerCase()), eq(workspaceInvitations.status, 'pending'), gt(workspaceInvitations.expiresAt, new Date()))).limit(1)
      if (!candidate) throw new WorkspaceError('inviteInvalid')
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, candidate.workspaceId)).for('update')
      const [invitation] = await tx.select({ id: workspaceInvitations.id, role: workspaceInvitations.role }).from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, candidate.workspaceId), eq(workspaceInvitations.tokenHash, hashToken(token)), eq(workspaceInvitations.email, user.email.toLowerCase()), eq(workspaceInvitations.status, 'pending'), gt(workspaceInvitations.expiresAt, new Date()))).for('update').limit(1)
      if (!invitation) throw new WorkspaceError('inviteExpired')
      const [existing] = await tx.select({ status: workspaceMembers.status }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, candidate.workspaceId), eq(workspaceMembers.userId, user.id))).limit(1)
      if (existing?.status === 'suspended') throw new WorkspaceError('workspaceMembershipSuspended')
      if (!existing) {
        await tx.insert(workspaceMembers).values({ workspaceId: candidate.workspaceId, userId: user.id, name: user.name, email: user.email.toLowerCase(), role: invitation.role })
        await enqueueWorkspaceAudit(tx, { workspaceId: candidate.workspaceId, actor: { type: 'user', id: user.id, name: user.name }, action: 'member.joined', target: { type: 'member', id: user.id }, metadata: { role: invitation.role }, ...request })
      }
      await tx.update(workspaceInvitations).set({ status: 'accepted' }).where(and(eq(workspaceInvitations.id, invitation.id), eq(workspaceInvitations.workspaceId, candidate.workspaceId), eq(workspaceInvitations.email, user.email.toLowerCase())))
      return candidate.workspaceId
    })
    await rememberWorkspace(workspaceId)
    return { workspaceId }
  })
}
