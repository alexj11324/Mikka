import { tokenWorkspace } from '@/lib/tokens/principal'
import { getLocale } from 'next-intl/server'
import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaces, workspaceMembers, workspaceInvitations } from '@/lib/db/workspace-schema'
import { renameGeneratedWorkspace, type WorkspaceLocale } from '@/lib/workspace-name'
import { ensurePersonalShare, ensurePersonalWorkspace } from '@/lib/personal-workspace'

function workspaceLocale(value: string): WorkspaceLocale {
  return value === 'en' ? 'en' : 'zh-CN'
}

import { WorkspaceError } from '@/lib/workspace-error'
export { WorkspaceError }

export type WorkspaceTransaction = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]
type AuthenticatedUser = Awaited<ReturnType<typeof requireUser>>

export async function requireWorkspace(tx: WorkspaceTransaction, workspaceId: string, userId: string, admin = false) {
  z.uuid().parse(workspaceId)
  const [row] = await tx.select({ workspace: workspaces, membership: workspaceMembers }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaces.id, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .for('update').limit(1)
  if (!row || (admin && row.membership.role !== 'admin')) throw new WorkspaceError('workspaceAccessDenied')
  return row
}

export async function loadWorkspaceContext(requestedId?: string, authenticatedUser?: AuthenticatedUser) {
  if (requestedId) z.uuid().parse(requestedId)
  const [user, locale] = await Promise.all([authenticatedUser ?? requireUser(), getLocale().then(workspaceLocale)])
  const patWorkspace = (user as typeof user & { [tokenWorkspace]?: string })[tokenWorkspace]
  if (patWorkspace && requestedId && requestedId !== patWorkspace) throw new WorkspaceError('workspaceAccessDenied')
  const context = await readWorkspaceContext(user.id, user.email, user.name, user.image ?? null, patWorkspace ?? requestedId ?? '', locale)
  return patWorkspace ? { ...context, choices: context.choices.filter(choice => choice.id === patWorkspace) } : context
}

// The pages, the switcher and the list actions all ask for the same context. React cache shares it
// within one server render only (never across requests or users); the key is all primitives.
const readWorkspaceContext = cache(async (userId: string, email: string, name: string, image: string | null, requestedId: string, locale: WorkspaceLocale) => {
  const user = { id: userId, email, name, image }
  const cookieStore = await cookies()
  const readChoices = () => workspaceDb.select({ id: workspaces.id, name: workspaces.name, kind: workspaces.kind, role: workspaceMembers.role }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaces.createdAt))

  let choices = await readChoices()
  // Every person has one personal workspace, including people whose first workspace came from an invite.
  if (!choices.some(choice => choice.kind === 'personal')) {
    await ensurePersonalWorkspace(user, locale)
    choices = await readChoices()
  }
  const personal = choices.find(choice => choice.kind === 'personal')
  if (personal) await ensurePersonalShare(user.id, personal.id)

  const savedId = cookieStore.get('mikka-workspace')?.value
  const workspaceId = requestedId || (choices.find(item => item.id === savedId)?.id ?? choices[0]?.id)
  let selected = choices.find(item => item.id === workspaceId)
  if (selected) {
    const nextName = renameGeneratedWorkspace(selected.name, locale, user.name)
    if (nextName) {
      const [owned] = await workspaceDb.select({ userId: workspaces.userId }).from(workspaces).where(eq(workspaces.id, selected.id)).limit(1)
      if (owned?.userId === user.id) {
        const name = nextName.slice(0, 120)
        await workspaceDb.update(workspaces).set({ name }).where(and(eq(workspaces.id, selected.id), eq(workspaces.userId, user.id)))
        choices = choices.map(item => item.id === selected?.id ? { ...item, name } : item)
        selected = choices.find(item => item.id === workspaceId)
      }
    }
  }
  if (!selected) throw new WorkspaceError('workspaceAccessDenied')
  return {
    workspace: { id: selected.id, name: selected.name, kind: selected.kind },
    choices: choices.map(({ id, name, kind }) => ({ id, name, kind })),
    currentUserId: user.id,
    role: selected.role,
    currentUser: { name: user.name, email: user.email, image: user.image ?? null },
  }
})

export async function loadWorkspaceSettings(requestedId?: string, authenticatedUser?: AuthenticatedUser) {
  const context = await loadWorkspaceContext(requestedId, authenticatedUser)
  const workspaceId = context.workspace.id
  const [members, invitations] = await Promise.all([
    workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email, role: workspaceMembers.role, status: workspaceMembers.status, createdAt: workspaceMembers.createdAt })
      .from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)).orderBy(asc(workspaceMembers.createdAt)),
    context.role === 'admin'
      ? workspaceDb.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, createdAt: workspaceInvitations.createdAt, expiresAt: workspaceInvitations.expiresAt })
        .from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.status, 'pending'))).orderBy(asc(workspaceInvitations.createdAt))
      : [],
  ])
  // Auth profiles are only queried for members already authorized by the selected workspace.
  const profiles = members.length ? await db.select({ id: users.id, image: users.image }).from(users)
    .where(inArray(users.id, members.map(member => member.userId))) : []
  const images = new Map(profiles.map(profile => [profile.id, profile.image]))
  images.set(context.currentUserId, context.currentUser.image)
  return {
    ...context,
    members: members.map(member => ({ ...member, image: images.get(member.userId) ?? null, createdAt: member.createdAt.toISOString() })),
    invitations: invitations.map(invite => ({ ...invite, createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString() })),
  }
}

export type WorkspaceSettings = Awaited<ReturnType<typeof loadWorkspaceSettings>>
