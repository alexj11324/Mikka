import { getTranslations } from 'next-intl/server'
import 'server-only'
import { cookies } from 'next/headers'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaces, workspaceMembers, workspaceInvitations } from '@/lib/db/workspace-schema'

export class WorkspaceError extends Error {}
export type WorkspaceTransaction = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]

export async function requireWorkspace(tx: WorkspaceTransaction, workspaceId: string, userId: string, admin = false) {
  const i18nText = await getTranslations();
  z.uuid().parse(workspaceId)
  const [row] = await tx.select({ workspace: workspaces, membership: workspaceMembers }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaces.id, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .for('update').limit(1)
  if (!row || (admin && row.membership.role !== 'admin')) throw new WorkspaceError(i18nText("Errors.workspaceAccessDenied"))
  return row
}

export async function loadWorkspaceContext(requestedId?: string) {
  const i18nText = await getTranslations();
  if (requestedId) z.uuid().parse(requestedId)
  const [user, cookieStore] = await Promise.all([requireUser(), cookies()])
  const readChoices = () => workspaceDb.select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaces.createdAt))
  const [own, existingChoices] = await Promise.all([
    workspaceDb.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.userId, user.id)).limit(1),
    readChoices(),
  ])
  if (!own.length) {
    await workspaceDb.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-owner:${user.id}`}, 0))`)
      const [existing] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.userId, user.id)).limit(1)
      if (existing) return
      const [created] = await tx.insert(workspaces).values({ id: crypto.randomUUID(), userId: user.id, name: i18nText("FeatureCopy.c_8ecc9561", { value0: (user.name || i18nText("FeatureCopy.c_a82c993d")) }).slice(0, 120) }).returning({ id: workspaces.id })
      await tx.insert(workspaceMembers).values({ workspaceId: created.id, userId: user.id, email: user.email.toLowerCase(), name: user.name, role: 'admin' })
    })
  }
  const choices = own.length ? existingChoices : await readChoices()
  const savedId = cookieStore.get('orvilo-workspace')?.value
  const workspaceId = requestedId ?? choices.find(item => item.id === savedId)?.id ?? choices[0]?.id
  const selected = choices.find(item => item.id === workspaceId)
  if (!selected) throw new WorkspaceError(i18nText("Errors.workspaceAccessDenied"))
  return {
    workspace: { id: selected.id, name: selected.name },
    choices: choices.map(({ id, name }) => ({ id, name })),
    currentUserId: user.id, role: selected.role,
    currentUser: { email: user.email, image: user.image ?? null },
  }
}

export async function loadWorkspaceSettings(requestedId?: string) {
  const context = await loadWorkspaceContext(requestedId)
  const workspaceId = context.workspace.id
  const readMembers = async () => {
    const members = await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email, role: workspaceMembers.role, status: workspaceMembers.status, createdAt: workspaceMembers.createdAt })
      .from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)).orderBy(asc(workspaceMembers.createdAt))
    // Auth profiles live in a separate database; only read IDs from this authorized workspace.
    const profiles = members.length ? await db.select({ id: users.id, image: users.image }).from(users)
      .where(inArray(users.id, members.map(member => member.userId))) : []
    const images = new Map(profiles.map(profile => [profile.id, profile.image]))
    return members.map(member => ({ ...member, image: images.get(member.userId) ?? null, createdAt: member.createdAt.toISOString() }))
  }
  // Read-only page loads must not take the row locks reserved for membership mutations.
  const [members, invitations] = await Promise.all([
    readMembers(),
    context.role === 'admin' ? workspaceDb.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, createdAt: workspaceInvitations.createdAt, expiresAt: workspaceInvitations.expiresAt })
      .from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.status, 'pending'))).orderBy(asc(workspaceInvitations.createdAt)) : Promise.resolve([]),
  ])
  return { ...context, members, invitations: invitations.map(invite => ({ ...invite, createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString() })) }
}
export type WorkspaceSettings = Awaited<ReturnType<typeof loadWorkspaceSettings>>
