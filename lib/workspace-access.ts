import { tokenWorkspace } from '@/lib/tokens/principal'
import { getLocale } from 'next-intl/server'
import 'server-only'
import { cookies } from 'next/headers'
import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import * as workspaceDatabase from '@/lib/workspace-db'
import { actingContext } from '@/lib/activity-actor'
import { readPendingWorkspaceChoices } from '@/lib/desktop-rpc/workspace-choices'
import { desktopHumanSessionId } from '@/lib/desktop-rpc/session'
import { workspaces, workspaceMembers, workspaceInvitations } from '@/lib/db/workspace-schema'
import { organizationWorkspaces } from '@/lib/db/governance-schema'
import { renameGeneratedWorkspace, type WorkspaceLocale } from '@/lib/workspace-name'
import { ensurePersonalShare, ensurePersonalWorkspace } from '@/lib/personal-workspace'
import type { ListLiveRead } from '@/lib/live/list-read'
import { ownerLiveScope } from '@/lib/live/owner-scope'
import { filterEnterpriseWorkspaceLinks, requireEnterpriseWorkspace } from '@/lib/enterprise/access'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'
import { getEdition, type MikkaEdition } from '@/lib/edition'
import { isServerAdmin } from '@/lib/server-admin'
import { currentRequestScope } from '@/apps/api/src/context'
import { workspaceSelection } from '@/lib/workspace-selection'

const { workspaceDb, workspacePool } = workspaceDatabase
// Private to this exact scalar projection, membership predicate and ordering.
const workspaceChoicesFamily = {}

function workspaceLocale(value: string): WorkspaceLocale {
  return value === 'en' ? 'en' : 'zh-CN'
}

import { WorkspaceError } from '@/lib/workspace-error'
export { WorkspaceError }

export type WorkspaceTransaction = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]
type AuthenticatedUser = Awaited<ReturnType<typeof requireUser>>

export async function requireWorkspace(tx: WorkspaceTransaction, workspaceId: string, userId: string, admin = false, principal?: EnterprisePrincipal) {
  z.uuid().parse(workspaceId)
  const [row] = await tx.select({ workspace: workspaces, membership: workspaceMembers }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaces.id, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .for('update').limit(1)
  if (!row || (admin && row.membership.role !== 'admin')) throw new WorkspaceError('workspaceAccessDenied')
  await requireEnterpriseWorkspace(userId, workspaceId, principal, tx)
  return row
}

export async function loadWorkspaceContext(requestedId?: string, authenticatedUser?: AuthenticatedUser) {
  if (requestedId) z.uuid().parse(requestedId)
  const selection = workspaceSelection(currentRequestScope()?.headers)
  if (selection.present && !selection.workspaceId) throw new WorkspaceError('workspaceAccessDenied')
  const [user, locale] = await Promise.all([authenticatedUser ?? requireUser(), getLocale().then(workspaceLocale)])
  const patWorkspace = (user as typeof user & { [tokenWorkspace]?: string })[tokenWorkspace]
  if (patWorkspace && (requestedId && requestedId !== patWorkspace || selection.workspaceId && selection.workspaceId !== patWorkspace)) throw new WorkspaceError('workspaceAccessDenied')
  // An explicit business target keeps its existing access check. A supplied
  // transport selection is exact: inaccessible choices never fall back home.
  const { organizationId, ...context } = await readWorkspaceContext(user.id, user.email, user.name, user.image ?? null, patWorkspace ?? requestedId ?? selection.workspaceId ?? '', locale, user)
  if (selection.present && !context.choices.some(choice => choice.id === selection.workspaceId)) throw new WorkspaceError('workspaceAccessDenied')
  if (!(await filterEnterpriseWorkspaceLinks(user, [{ id: context.workspace.id, organizationId }])).length) throw new WorkspaceError('workspaceAccessDenied')
  return patWorkspace ? { ...context, choices: context.choices.filter(choice => choice.id === patWorkspace) } : context
}

// Membership and organization linkage share one fresh read. Only equivalent
// Native callers queued before that SELECT starts may share its observation;
// every later call reads again, even while the earlier result is still pending.
// Enterprise policy and principal checks remain independent for every caller.
async function readWorkspaceContext(userId: string, email: string, name: string, image: string | null, requestedId: string, locale: WorkspaceLocale, reader: AuthenticatedUser) {
  const user = { id: userId, email, name, image }
  const cookieStore = await cookies()
  const readChoices = () => readPendingWorkspaceChoices({
    family: workspaceChoicesFamily, database: workspacePool, request: currentRequestScope(),
    // Missing executor/transaction introspection is not evidence of a safe pool read.
    transaction: typeof workspaceDatabase.workspaceTransactionKey !== 'function' || workspaceDatabase.workspaceTransactionKey() !== null,
    identity: { userId, nativeSessionId: desktopHumanSessionId(), requestedId,
      tokenWorkspaceId: reader[tokenWorkspace], principal: reader[enterprisePrincipal], acting: actingContext.getStore() },
  }, () => workspaceDb.select({ id: workspaces.id, name: workspaces.name, kind: workspaces.kind, role: workspaceMembers.role, organizationId: organizationWorkspaces.organizationId }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .leftJoin(organizationWorkspaces, eq(organizationWorkspaces.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active'),
      or(eq(workspaces.kind, 'team'), eq(workspaces.userId, user.id)))).orderBy(asc(workspaces.createdAt)))

  let choices = await readChoices()
  // Every person has one personal workspace, including people whose first workspace came from an invite.
  if (!choices.some(choice => choice.kind === 'personal')) {
    await ensurePersonalWorkspace(user, locale)
    choices = await readChoices()
  }
  const personal = choices.find(choice => choice.kind === 'personal')
  if (personal) await ensurePersonalShare(user.id, personal.id)

  const savedId = cookieStore.get('mikka-workspace')?.value
  // A cookie-less client starts in its own workspace, even if it joined a team first.
  const workspaceId = requestedId || (choices.find(item => item.id === savedId)?.id ?? personal?.id ?? choices[0]?.id)
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
    organizationId: selected.organizationId,
    workspace: { id: selected.id, name: selected.name, kind: selected.kind },
    choices: choices.map(({ id, name, kind }) => ({ id, name, kind })),
    currentUserId: user.id,
    role: selected.role,
    currentUser: { name: user.name, email: user.email, image: user.image ?? null },
  }
}

export async function loadWorkspaceSettings(requestedId?: string, authenticatedUser?: AuthenticatedUser) {
  const observedAt = Date.now()
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
  const nextExpiry = invitations.map(invite => invite.expiresAt.getTime()).filter(at => at > observedAt).sort((a, b) => a - b)[0]
  const home = await ownerLiveScope(workspacePool, context.currentUserId)
  const live: { live?: ListLiveRead & { homeWorkspaceId: string | null } } = { live: { ownerId: context.currentUserId, workspaceId, homeWorkspaceId: home?.workspaceId ?? null,
    ...(nextExpiry === undefined ? {} : { deadline: { at: new Date(nextExpiry).toISOString(), afterMs: nextExpiry - observedAt } }),
  } }
  // Optional on the wire for clients that still connect to a pre-edition server.
  const deployment: { edition?: MikkaEdition; serverAdmin?: boolean } = { edition: getEdition(), serverAdmin: isServerAdmin(context.currentUserId) }
  return {
    ...context,
    ...live,
    ...deployment,
    members: members.map(member => ({ ...member, image: images.get(member.userId) ?? null, createdAt: member.createdAt.toISOString() })),
    invitations: invitations.map(invite => ({ ...invite, createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString() })),
  }
}

export type WorkspaceSettings = Awaited<ReturnType<typeof loadWorkspaceSettings>>
