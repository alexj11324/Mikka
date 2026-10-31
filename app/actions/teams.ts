'use server'
import { getTranslations } from 'next-intl/server'

import { and, asc, count, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { teams, teamMembers } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { loadWorkspaceContext, requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { accessibleTeams, requireTeam } from '@/lib/team-access'
import type { ActionResult } from '@/lib/action-result'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { deleteTeamData, teamDeletionImpact, type TeamDeletion, type TeamDeletionImpact } from '@/lib/workspace-admin/teams'

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
    accessibleTeams(context.currentUserId, context.workspace.id),
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
    const values = fields.parse(input)
    return workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, input.workspaceId, user.id)
      if (input.id) {
        const current = await requireTeam(tx, input.id, user.id, true)
        if (current.workspaceId !== input.workspaceId) throw new WorkspaceError(i18nText("FeatureCopy.c_55559894"))
        const [team] = await tx.update(teams).set({ ...values, updatedAt: new Date() }).where(and(eq(teams.id, input.id), eq(teams.workspaceId, current.workspaceId))).returning()
        return team
      }
      const [team] = await tx.insert(teams).values({ ...values, id: crypto.randomUUID(), workspaceId: input.workspaceId, userId: user.id }).returning()
      await tx.insert(teamMembers).values({ teamId: team.id, userId: user.id, role: 'owner' })
      return team
    })
  })
}
export async function listTeamMembers(id: string, tokenWorkspaceId?: string) {
  const user = await requireUser()
  return workspaceDb.transaction(async tx => {
    const team = await requireTeam(tx, id, user.id)
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
export async function changeTeamMember(input: { teamId: string; userId?: string; action: 'join' | 'leave' | 'add' | 'remove' | 'owner' | 'member' }) {
  const i18nText = await getTranslations();
  return result(async () => {
    const user = await requireUser()
    const action = z.enum(['join', 'leave', 'add', 'remove', 'owner', 'member']).parse(input.action)
    const targetId = action === 'join' || action === 'leave' ? user.id : z.string().min(1).max(200).parse(input.userId)
    await workspaceDb.transaction(async tx => {
      const team = await requireTeam(tx, input.teamId, user.id, action !== 'join' && action !== 'leave')
      const [target] = await tx.select({ status: workspaceMembers.status }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, team.workspaceId), eq(workspaceMembers.userId, targetId))).limit(1)
      if (!target || (target.status !== 'active' && action !== 'remove')) throw new WorkspaceError(i18nText("FeatureCopy.c_ddc37f65"))
      if (action === 'join' || action === 'add') { await tx.insert(teamMembers).values({ teamId: team.id, userId: targetId }).onConflictDoNothing(); return }
      const [current] = await tx.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetId))).limit(1)
      if (!current) throw new WorkspaceError(i18nText("FeatureCopy.c_5aa7a0e5"))
      if (current.role === 'owner' && action !== 'owner') {
        const owners = await tx.select({ id: teamMembers.userId }).from(teamMembers).innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, team.workspaceId), eq(workspaceMembers.userId, teamMembers.userId), eq(workspaceMembers.status, 'active'))).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.role, 'owner'), ne(teamMembers.userId, targetId))).limit(1)
        if (!owners.length) throw new WorkspaceError(i18nText("FeatureCopy.c_8f627e89"))
      }
      const scope = and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetId))
      if (action === 'leave' || action === 'remove') await tx.delete(teamMembers).where(scope)
      else await tx.update(teamMembers).set({ role: action === 'owner' ? 'owner' : 'member' }).where(scope)
    })
  })
}

/** 删除团队 dialog: how many tasks and projects go with the team. Workspace admins only. */
export async function getTeamDeletionImpact(teamId: string): Promise<ActionResult<TeamDeletionImpact>> {
  return workspaceAction(async () => teamDeletionImpact((await requireUser()).id, teamId))
}

/** 删除团队 and its tasks and own projects. `confirmName` must equal the team name. Workspace admins only. */
export async function deleteTeam(teamId: string, confirmName: string): Promise<ActionResult<TeamDeletion>> {
  return workspaceAction(async () => deleteTeamData((await requireUser()).id, teamId, confirmName))
}
