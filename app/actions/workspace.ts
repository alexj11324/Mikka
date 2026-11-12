'use server'

import { withFreshSession } from '@/lib/fresh-session'
import { getLocale, getTranslations } from 'next-intl/server'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import { cookies, headers } from 'next/headers'
import { auth, type DeviceSessionSummary } from '@/lib/auth'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaceInvitations, workspaces } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { slugIsReserved } from '@/lib/workspace-admin/general'
import { transferOnSuspend } from '@/lib/workspace-admin/members'
import { auditRequestContext } from '@/lib/audit/record'
import { enqueueWorkspaceAudit } from '@/lib/audit/delivery'
import { ensurePersonalWorkspace } from '@/lib/personal-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { ownerWorkspaceListsChanged, workspaceListChanged, workspaceListScopesBeforeChange, workspaceListScopeChanged } from '@/lib/live/lists'
import { pool } from '@/lib/db'
import { markReviewSessionsRevoked, drainRevokedReviewSessions } from '@/lib/coding-workspace/review-sessions'

import { acceptHumanInvitation, updateHumanMembership } from '@/lib/governance/member-admission'
import { drainMemberLifecycleOutbox } from '@/lib/governance/member-outbox'
import { planInvitations } from '@/lib/batch-outcome'
import { GovernanceError } from '@/lib/governance/errors'

const roleSchema = z.enum(['admin', 'member'])
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/)
const workspaceSlug = z.string().trim().min(3).max(64).regex(/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/)
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** One address of an invitation batch: the link it got, or why it was skipped (ALE-28). */
type InvitationOutcome =
  | { email: string; created: true; path: string }
  | { email: string; created: false; reason: 'alreadyMember' | 'duplicate' }

async function result<T>(operation: () => Promise<T>) {
  try {
    return { ok: true as const, data: await operation() }
  } catch (error) {
    if (error instanceof GovernanceError) {
      const t = await getTranslations('RunErrors.governance_denied')
      return { ok: false as const, error: t(error.detail ?? 'default') }
    }
    const t = await getTranslations('Errors')
    if (error instanceof WorkspaceError) {
      return { ok: false as const, error: t.has(error.code as never) ? t(error.code as never) : error.message }
    }
    if (error instanceof z.ZodError) return { ok: false as const, error: t('validationGeneric') }
    console.error('Workspace operation failed', error instanceof Error ? error.name : 'UnknownError')
    return { ok: false as const, error: t('generic') }
  }
}

/** A person's first workspace is their personal one (decision 2026-11-02-1500): it exists before they create or join a team. */
async function ensurePersonalFirst(user: { id: string; email: string; name: string }) {
  await ensurePersonalWorkspace(user, (await getLocale()) === 'en' ? 'en' : 'zh-CN')
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
    await ensurePersonalFirst(user)
    const workspaceId = crypto.randomUUID()
    await workspaceDb.transaction(async tx => {
      // An old slug of another workspace keeps redirecting there, so it cannot be reused.
      if (await slugIsReserved(tx, slug)) throw new WorkspaceError(i18nText('FeatureCopy.c_a56de3c3'))
      const [created] = await tx.insert(workspaces).values({ id: workspaceId, userId: user.id, name, slug }).onConflictDoNothing({ target: workspaces.slug }).returning({ id: workspaces.id })
      if (!created) throw new WorkspaceError(i18nText('FeatureCopy.c_a56de3c3'))
      await tx.insert(workspaceMembers).values({ workspaceId, userId: user.id, name: user.name, email: user.email.toLowerCase(), role: 'admin' })
      await workspaceListChanged(tx, workspaceId, ['workspace_settings'])
      await ownerWorkspaceListsChanged(tx, user.id, ['workspace_settings'])
    })
    await rememberWorkspace(workspaceId)
    return { workspaceId, slug }
  })
}

async function switchWorkspaceBody(input: string | { workspaceId?: string; accountId?: string }) {
  const i18nText = await getTranslations()
  return result(async () => {
    const user = await requireUser()
    const parsed = typeof input === 'string'
      ? { workspaceId: z.uuid().parse(input), accountId: user.id }
      : z.object({ workspaceId: z.uuid().optional(), accountId: z.string().min(1).max(200).optional() }).parse(input)
    const accountId = parsed.accountId ?? user.id
    const pinned = user[tokenWorkspace]
    if (pinned && (accountId !== user.id || parsed.workspaceId && parsed.workspaceId !== pinned)) throw new WorkspaceError('workspaceAccessDenied')
    const deviceSessions: DeviceSessionSummary[] = accountId === user.id ? [] : await auth.api.listDeviceSessions({ headers: await headers() })
    const deviceSession = deviceSessions.find(item => item.user.id === accountId)
    if (accountId !== user.id && !deviceSession) throw new WorkspaceError(i18nText('FeatureCopy.c_c2e795ad'))
    if (parsed.workspaceId) await workspaceDb.transaction(async tx => {
      const { workspace } = await requireWorkspace(tx, parsed.workspaceId!, accountId)
      if (workspace.kind === 'personal' && workspace.userId !== accountId) throw new WorkspaceError('workspaceAccessDenied')
    })
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

export async function switchWorkspace(...args: Parameters<typeof switchWorkspaceBody>) {
  return withFreshSession(() => switchWorkspaceBody(...args))
}

/**
 * One outcome per address (ALE-28). A batch of up to 20 addresses reports which
 * ones got a link and which were skipped, instead of failing all of them for one
 * address that is already a member: the person can correct exactly those.
 */
/** The links this action returns as `data`, and the per-address answer beside them. */
type InvitationBatch = { links: { email: string; path: string }[]; outcomes: InvitationOutcome[] }

async function createWorkspaceInvitationBody(input: { workspaceId: string; emails: string[]; role: string }): Promise<{ ok: true; data: InvitationBatch } | { ok: false; error: string }> {
  return result(async () => {
    const user = await requireUser()
    const role = roleSchema.parse(input.role)
    const emails = z.array(z.email().max(254)).min(1).max(20).parse(input.emails.map(email => email.trim().toLowerCase()))
    const request = auditRequestContext(await headers())
    const outcomes = await workspaceDb.transaction(async tx => {
      const { workspace } = await requireWorkspace(tx, input.workspaceId, user.id, true)
      // A personal workspace has exactly one member (decision 2026-10-31-2130).
      if (workspace.kind === 'personal') throw new WorkspaceError('workspacePersonal')
      const members = new Set((await tx.select({ email: workspaceMembers.email }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, input.workspaceId))).map(member => member.email.toLowerCase()))
      const results: InvitationOutcome[] = []
      for (const outcome of planInvitations(emails, members)) {
        if (!outcome.used) { results.push({ email: outcome.item, created: false, reason: outcome.reason }); continue }
        const email = outcome.item
        const token = randomBytes(32).toString('hex')
        const tokenHash = hashToken(token)
        const expiresAt = new Date(Date.now() + 7 * 86400000)
        await tx.insert(workspaceInvitations).values({ id: crypto.randomUUID(), workspaceId: input.workspaceId, userId: user.id, email, role, tokenHash, expiresAt })
          .onConflictDoUpdate({ target: [workspaceInvitations.workspaceId, workspaceInvitations.email], set: { userId: user.id, role, tokenHash, status: 'pending', expiresAt, createdAt: new Date() } })
        await enqueueWorkspaceAudit(tx, { workspaceId: input.workspaceId, actor: { type: 'user', id: user.id, name: user.name }, action: 'member.invited', target: { type: 'invitation', label: email }, metadata: { role }, ...request })
        results.push({ email, created: true, path: `/invite/${token}` })
      }
      // A batch with nothing to create wrote nothing; its outcomes still say why,
      // which is the answer the person needs, so it is not read as a failure.
      if (results.some(result => result.created)) await workspaceListChanged(tx, input.workspaceId, ['workspace_settings'])
      return results
    })
    return {
      links: outcomes.flatMap(outcome => outcome.created ? [{ email: outcome.email, path: outcome.path }] : []),
      outcomes,
    }
  })
}

/** Puts the per-address answers beside the links, in the shape callers already read. */
async function invitationBatch(...args: Parameters<typeof createWorkspaceInvitationBody>) {
  const body = await createWorkspaceInvitationBody(...args)
  if (!body.ok) return body
  return { ok: true as const, data: body.data.links, outcomes: body.data.outcomes }
}

/**
 * Role and status. When suspending, `transferTo` (optional, another active
 * member) takes over the suspended member's bots in this workspace.
 */
async function updateWorkspaceMemberBody(input: { workspaceId: string; userId: string; role: string; status: string; transferTo?: string }) {
  return result(async () => {
    const user = await requireUser()
    const role = roleSchema.parse(input.role)
    const status = z.enum(['active', 'suspended']).parse(input.status)
    z.string().min(1).max(200).parse(input.userId)
    if (input.transferTo !== undefined && status !== 'suspended') throw new WorkspaceError('validationGeneric')
    const request = auditRequestContext(await headers())
    let reviewIds: string[] = []
    let previous: string
    try { previous = await workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, input.workspaceId, user.id, true)
      const [target] = await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))).for('update').limit(1)
      if (!target) throw new WorkspaceError('workspaceMemberNotFound')
      if (target.role === 'admin' && target.status === 'active' && (role !== 'admin' || status !== 'active')) {
        const others = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), ne(workspaceMembers.userId, input.userId), eq(workspaceMembers.role, 'admin'), eq(workspaceMembers.status, 'active'))).limit(1)
        if (!others.length) throw new WorkspaceError('workspaceLastAdmin')
      }
      const base = { workspaceId: input.workspaceId, actor: { type: 'user' as const, id: user.id, name: user.name }, target: { type: 'member', id: target.userId, label: target.name || target.email }, ...request }
      if (target.role !== role) await enqueueWorkspaceAudit(tx, { ...base, action: 'member.role_changed', metadata: { oldRole: target.role, newRole: role } })
      if (target.status !== status) await enqueueWorkspaceAudit(tx, { ...base, action: status === 'suspended' ? 'member.suspended' : 'member.reactivated' })
      if (target.status !== 'suspended' && status === 'suspended') {
        reviewIds = await markReviewSessionsRevoked(pool, { workspaceId: input.workspaceId, ownerId: input.userId }, 'membership_changed')
      }
      if (input.transferTo !== undefined) await transferOnSuspend(tx, input.workspaceId, input.userId, input.transferTo)
      const before = await workspaceListScopesBeforeChange(tx, input.workspaceId)
      await updateHumanMembership(tx, { workspaceId: input.workspaceId, userId: input.userId, role, status })
      if (target.role !== role || target.status !== status) await workspaceListScopeChanged(tx, input.workspaceId, before)
      return target.status
    }) } finally { await drainRevokedReviewSessions(pool, reviewIds) }
    // §8.3: a suspended member's share and bots leave with them; reactivation brings their bots back.
    if (previous !== status) await drainMemberLifecycleOutbox(input.workspaceId, input.userId)
  })
}

async function revokeWorkspaceInvitationBody(workspaceId: string, invitationId: string) {
  return result(async () => {
    const user = await requireUser()
    z.uuid().parse(invitationId)
    const request = auditRequestContext(await headers())
    await workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, workspaceId, user.id, true)
      const [revoked] = await tx.update(workspaceInvitations).set({ status: 'revoked' }).where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.id, invitationId), eq(workspaceInvitations.status, 'pending'))).returning({ id: workspaceInvitations.id })
      if (revoked) await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'user', id: user.id, name: user.name }, action: 'member.invitation_revoked', target: { type: 'invitation', id: revoked.id }, ...request })
      if (revoked) await workspaceListChanged(tx, workspaceId, ['workspace_settings'])
    })
  })
}

async function acceptWorkspaceInvitationBody(token: string) {
  return result(async () => {
    const user = await requireUser()
    tokenSchema.parse(token)
    const request = auditRequestContext(await headers())
    await ensurePersonalFirst(user)
    const workspaceId = await workspaceDb.transaction(async tx => {
      const admission = await acceptHumanInvitation(tx, user, hashToken(token))
      if (admission.joined) await enqueueWorkspaceAudit(tx, { workspaceId: admission.workspaceId, actor: { type: 'user', id: user.id, name: user.name }, action: 'member.joined', target: { type: 'member', id: user.id }, metadata: { role: admission.role }, ...request })
      await workspaceListChanged(tx, admission.workspaceId, ['workspace_settings', 'issue_list'])
      await ownerWorkspaceListsChanged(tx, user.id, ['workspace_settings'])
      return admission.workspaceId
    })
    await rememberWorkspace(workspaceId)
    return { workspaceId }
  })
}

// Money, permissions, credentials and deletion: the session is read from the database, not the cookie cache.
/// `data` keeps the array of links this action has always returned, so every
/// existing caller and RPC consumer keeps working; `outcomes` sits beside it
/// with one entry per address (ALE-28). The fresh-session wrapper stays the
/// one-line shape `tests/session-cookie-cache.db.test.ts` pins for this action.
export async function createWorkspaceInvitation(...args: Parameters<typeof createWorkspaceInvitationBody>) { return withFreshSession(() => invitationBatch(...args)) }
export async function updateWorkspaceMember(...args: Parameters<typeof updateWorkspaceMemberBody>) { return withFreshSession(() => updateWorkspaceMemberBody(...args)) }
export async function revokeWorkspaceInvitation(...args: Parameters<typeof revokeWorkspaceInvitationBody>) { return withFreshSession(() => revokeWorkspaceInvitationBody(...args)) }
export async function acceptWorkspaceInvitation(...args: Parameters<typeof acceptWorkspaceInvitationBody>) { return withFreshSession(() => acceptWorkspaceInvitationBody(...args)) }
