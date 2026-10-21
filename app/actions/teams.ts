'use server'

import { and, asc, count, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { teams, teamMembers } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { loadWorkspaceContext, requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { accessibleTeams, requireTeam } from '@/lib/team-access'

const fields = z.object({ name: z.string().trim().min(1, '请填写团队名称。').max(100), identifier: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,11}$/, '标识须为 2–12 位大写字母或数字，并以字母开头。'), description: z.string().trim().max(500) })
async function result<T>(operation: () => Promise<T>) {
  try { return { ok: true as const, data: await operation() } }
  catch (error) {
    if (error instanceof WorkspaceError) return { ok: false as const, error: error.message }
    if (error instanceof z.ZodError) return { ok: false as const, error: error.issues[0]?.message ?? '参数不正确。' }
    console.error('Team operation failed', error instanceof Error ? error.name : 'UnknownError')
    return { ok: false as const, error: '操作失败，团队标识可能已存在，请检查后重试。' }
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
  return result(async () => {
    const user = await requireUser()
    const values = fields.parse(input)
    return workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, input.workspaceId, user.id)
      if (input.id) {
        const current = await requireTeam(tx, input.id, user.id, true)
        if (current.workspaceId !== input.workspaceId) throw new WorkspaceError('团队不能转移到其他工作区。')
        const [team] = await tx.update(teams).set({ ...values, updatedAt: new Date() }).where(and(eq(teams.id, input.id), eq(teams.workspaceId, current.workspaceId))).returning()
        return team
      }
      const [team] = await tx.insert(teams).values({ ...values, id: crypto.randomUUID(), workspaceId: input.workspaceId, userId: user.id }).returning()
      await tx.insert(teamMembers).values({ teamId: team.id, userId: user.id, role: 'owner' })
      return team
    })
  })
}
export async function listTeamMembers(id: string) {
  const user = await requireUser()
  return workspaceDb.transaction(async tx => {
    const team = await requireTeam(tx, id, user.id)
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
  return result(async () => {
    const user = await requireUser()
    const action = z.enum(['join', 'leave', 'add', 'remove', 'owner', 'member']).parse(input.action)
    const targetId = action === 'join' || action === 'leave' ? user.id : z.string().min(1).max(200).parse(input.userId)
    await workspaceDb.transaction(async tx => {
      const team = await requireTeam(tx, input.teamId, user.id, action !== 'join' && action !== 'leave')
      const [target] = await tx.select({ status: workspaceMembers.status }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, team.workspaceId), eq(workspaceMembers.userId, targetId))).limit(1)
      if (!target || (target.status !== 'active' && action !== 'remove')) throw new WorkspaceError('只能添加或设置启用中的工作区成员。')
      if (action === 'join' || action === 'add') { await tx.insert(teamMembers).values({ teamId: team.id, userId: targetId }).onConflictDoNothing(); return }
      const [current] = await tx.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetId))).limit(1)
      if (!current) throw new WorkspaceError('该成员不在团队中。')
      if (current.role === 'owner' && action !== 'owner') {
        const owners = await tx.select({ id: teamMembers.userId }).from(teamMembers).innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, team.workspaceId), eq(workspaceMembers.userId, teamMembers.userId), eq(workspaceMembers.status, 'active'))).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.role, 'owner'), ne(teamMembers.userId, targetId))).limit(1)
        if (!owners.length) throw new WorkspaceError('团队须保留至少一位启用中的负责人，请先指定另一位负责人。')
      }
      const scope = and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetId))
      if (action === 'leave' || action === 'remove') await tx.delete(teamMembers).where(scope)
      else await tx.update(teamMembers).set({ role: action === 'owner' ? 'owner' : 'member' }).where(scope)
    })
  })
}
