'use server'
import { withFreshSession } from '@/lib/fresh-session'
import { getTranslations } from 'next-intl/server'

import { and, asc, count, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { teams, teamMembers } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { loadWorkspaceContext, requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { accessibleTeams, lockTeamRelations, requireActiveTeam, requireTeam } from '@/lib/team-access'
import type { ActionResult } from '@/lib/action-result'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { archiveTeamData, deleteTeamData, readTeamLifecycleAudit, removeTeamGroupingData, restoreTeamData, teamDeletionImpact, teamLifecycleImpact, type TeamDeletion, type TeamDeletionImpact } from '@/lib/workspace-admin/teams'
import { workspaceListChanged } from '@/lib/live/lists'
import { pool } from '@/lib/db'
import { stopRunsForPolicyChange } from '@/lib/run-policy-stop'
import { tokenWorkspace } from '@/lib/tokens/principal'

function assertTokenWorkspace(user: Awaited<ReturnType<typeof requireUser>>, workspaceId: string) {
  const bound = (user as typeof user & { [tokenWorkspace]?: string })[tokenWorkspace]
  if (bound && bound !== workspaceId) throw new WorkspaceError('workspaceAccessDenied')
}
async function teamLifecycleActor(teamId: string) {
  z.uuid().parse(teamId)
  const user = await requireUser()
  const [team] = await workspaceDb.select({ workspaceId: teams.workspaceId }).from(teams).where(eq(teams.id, teamId)).limit(1)
  if (!team) throw new WorkspaceError('teamNotFound')
  assertTokenWorkspace(user, team.workspaceId)
  return user.id
}

const fields = z.object({ name: z.string().trim().min(1, 'validationNameRequired').max(100), identifier: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,11}$/, 'teamIdentifierInvalid'), description: z.string().trim().max(500) })
async function result<T>(operation: () => Promise<T>) {
  const i18nText = await getTranslations();
  try { return { ok: true as const, data: await operation() } }
  catch (error) {
    if (error instanceof WorkspaceError) return { ok: false as const, error: error.message }
    if (error instanceof z.ZodError) {
      const code = error.issues[0]?.message
      const key = code === 'validationNameRequired' || code === 'teamIdentifierInvalid' ? `Errors.${code}` : 'Errors.validationGeneric'
      return { ok: false as const, error: i18nText(key as never) }
    }
    console.error('Team operation failed', error instanceof Error ? error.name : 'UnknownError')
    return { ok: false as const, error: i18nText("FeatureCopy.c_d4a4d764") }
  }
}
export async function listTeams() {
  const context = await loadWorkspaceContext()
  return accessibleTeams(context.currentUserId, context.workspace.id)
}
export async function loadTeamDirectory(workspaceId?: string) {
  const context = await loadWorkspaceContext(workspaceId)
  const [all, counts] = await Promise.all([
    accessibleTeams(context.currentUserId, context.workspace.id, { includeArchived: true }),
    workspaceDb.select({ teamId: teamMembers.teamId, total: count() }).from(teamMembers)
      .innerJoin(teams, and(eq(teams.id, teamMembers.teamId), eq(teams.workspaceId, context.workspace.id)))
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, context.workspace.id), eq(workspaceMembers.userId, teamMembers.userId), eq(workspaceMembers.status, 'active')))
      .groupBy(teamMembers.teamId),
  ])
  const memberCounts = new Map(counts.map(row => [row.teamId, row.total]))
  return { ...context, teams: all.map(team => ({ ...team, memberCount: memberCounts.get(team.id) ?? 0 })) }
}
export async function saveTeam(input: { id?: string; workspaceId: string; name: string; identifier: string; description: string }) {
  const i18nText = await getTranslations();
  return result(async () => {
    const user = await requireUser()
    assertTokenWorkspace(user, input.workspaceId)
    const values = fields.parse(input)
    return workspaceDb.transaction(async tx => {
      const { workspace } = await requireWorkspace(tx, input.workspaceId, user.id)
      await lockTeamRelations(tx)
      if (input.id) {
        const current = await requireActiveTeam(tx, input.id, user.id, true, input.workspaceId)
        if (current.workspaceId !== input.workspaceId) throw new WorkspaceError(i18nText("FeatureCopy.c_55559894"))
        const [team] = await tx.update(teams).set({ ...values, updatedAt: new Date() }).where(and(eq(teams.id, input.id), eq(teams.workspaceId, current.workspaceId))).returning()
        await workspaceListChanged(tx, current.workspaceId, ['workspace_settings', 'issue_list'])
        return team
      }
      if (workspace.kind === 'personal') throw new WorkspaceError('teamPersonalWorkspace')
      const [team] = await tx.insert(teams).values({ ...values, id: crypto.randomUUID(), workspaceId: input.workspaceId, userId: user.id }).returning()
      await tx.insert(teamMembers).values({ teamId: team.id, userId: user.id, role: 'owner' })
      await workspaceListChanged(tx, input.workspaceId, ['workspace_settings', 'issue_list'])
      return team
    })
  })
}
export async function listTeamMembers(id: string, tokenWorkspaceId?: string) {
  const user = await requireUser()
  return workspaceDb.transaction(async tx => {
    const team = await requireTeam(tx, id, user.id)
    assertTokenWorkspace(user, team.workspaceId)
    if (tokenWorkspaceId && tokenWorkspaceId !== team.workspaceId) throw new WorkspaceError('workspaceAccessDenied')
    const members = await tx.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email, status: workspaceMembers.status, role: teamMembers.role }).from(teamMembers)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, teamMembers.userId), eq(workspaceMembers.workspaceId, team.workspaceId)))
      .where(eq(teamMembers.teamId, id)).orderBy(asc(teamMembers.createdAt))
    const canManage = team.admin === 'admin' || team.role === 'owner'
    const availableMembers = canManage ? await tx.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email, status: workspaceMembers.status }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, team.workspaceId), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaceMembers.createdAt)) : []
    return { members, canManage, workspaceMembers: availableMembers }
  })
}
async function changeTeamMemberBody(input: { teamId: string; userId?: string; action: 'join' | 'leave' | 'add' | 'remove' | 'owner' | 'member' }) {
  const i18nText = await getTranslations();
  return result(async () => {
    const user = await requireUser()
    const action = z.enum(['join', 'leave', 'add', 'remove', 'owner', 'member']).parse(input.action)
    const targetId = action === 'join' || action === 'leave' ? user.id : z.string().min(1).max(200).parse(input.userId)
    await workspaceDb.transaction(async tx => {
      const team = await requireTeam(tx, input.teamId, user.id, action !== 'join' && action !== 'leave')
      assertTokenWorkspace(user, team.workspaceId)
      if (team.workspaceKind === 'personal' && action !== 'leave' && action !== 'remove') throw new WorkspaceError('teamPersonalWorkspace')
      if (team.archivedAt && action !== 'leave' && action !== 'remove') throw new WorkspaceError('teamArchived')
      const [target] = await tx.select({ status: workspaceMembers.status }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, team.workspaceId), eq(workspaceMembers.userId, targetId))).limit(1)
      if (!target || (target.status !== 'active' && action !== 'remove')) throw new WorkspaceError(i18nText("FeatureCopy.c_ddc37f65"))
      if (action === 'join' || action === 'add') {
        const added = await tx.insert(teamMembers).values({ teamId: team.id, userId: targetId }).onConflictDoNothing().returning({ id: teamMembers.userId })
        if (added.length) await workspaceListChanged(tx, team.workspaceId, ['workspace_settings', 'issue_list'])
        return
      }
      const [current] = await tx.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetId))).limit(1)
      if (!current) throw new WorkspaceError(i18nText("FeatureCopy.c_5aa7a0e5"))
      if (current.role === 'owner' && action !== 'owner') {
        const owners = await tx.select({ id: teamMembers.userId }).from(teamMembers).innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, team.workspaceId), eq(workspaceMembers.userId, teamMembers.userId), eq(workspaceMembers.status, 'active'))).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.role, 'owner'), ne(teamMembers.userId, targetId))).limit(1)
        if (!owners.length) throw new WorkspaceError(i18nText("FeatureCopy.c_8f627e89"))
      }
      const scope = and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetId))
      if (action === 'leave' || action === 'remove') {
        await stopRunsForPolicyChange(pool, { kind: 'team', scopeId: team.id, ownerId: targetId })
        await tx.delete(teamMembers).where(scope)
      }
      else await tx.update(teamMembers).set({ role: action === 'owner' ? 'owner' : 'member' }).where(scope)
      await workspaceListChanged(tx, team.workspaceId, ['workspace_settings', 'issue_list'])
    })
  })
}

/** Explicit hard-delete preview, including run/PR references and eligibility. */
export async function getTeamDeletionImpact(teamId: string): Promise<ActionResult<TeamDeletionImpact>> {
  return workspaceAction(async () => teamDeletionImpact(await teamLifecycleActor(teamId), teamId))
}

/** Hard delete is only available for empty teams; nonempty requests are refused. */
async function deleteTeamBody(teamId: string, confirmName: string): Promise<ActionResult<TeamDeletion>> {
  return workspaceAction(async () => deleteTeamData(await teamLifecycleActor(teamId), teamId, confirmName))
}

// Money, permissions, credentials and deletion: the session is read from the database, not the cookie cache.
export async function changeTeamMember(...args: Parameters<typeof changeTeamMemberBody>) { return withFreshSession(() => changeTeamMemberBody(...args)) }
export async function deleteTeam(...args: Parameters<typeof deleteTeamBody>) { return withFreshSession(() => deleteTeamBody(...args)) }

export async function getTeamLifecycleImpact(teamId: string) {
  return workspaceAction(async () => teamLifecycleImpact(await teamLifecycleActor(teamId), teamId))
}
export async function getTeamLifecycleAudit(workspaceId: string, teamId: string) {
  return workspaceAction(async () => {
    const user = await requireUser()
    assertTokenWorkspace(user, workspaceId)
    return readTeamLifecycleAudit(user.id, workspaceId, teamId)
  })
}
export async function archiveTeam(teamId: string) {
  return withFreshSession(() => workspaceAction(async () => archiveTeamData(await teamLifecycleActor(teamId), teamId)))
}
export async function restoreTeam(teamId: string) {
  return withFreshSession(() => workspaceAction(async () => restoreTeamData(await teamLifecycleActor(teamId), teamId)))
}
export async function removeTeamGrouping(teamId: string, confirmName: string) {
  return withFreshSession(() => workspaceAction(async () => removeTeamGroupingData(await teamLifecycleActor(teamId), teamId, confirmName)))
}
