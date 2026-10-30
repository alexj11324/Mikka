import 'server-only'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { issues, teamIssueCreateRequests, teamIssuePromotions } from '@/lib/db/schema'
import { projectEvents, projects } from '@/lib/db/project-schema'
import { teamIssueCreateReceipts, teamIssuePromotionReceipts, teamIssues, teamMembers, teamProjects, teams } from '@/lib/db/team-schema'
import { requireWorkspace, WorkspaceError, type WorkspaceTransaction } from '@/lib/workspace-access'
import { lockTeamRelations } from '@/lib/team-access'
import { workspaceDb } from '@/lib/workspace-db'

export interface TeamDeletionImpact { teamId: string; name: string; tasks: number; projects: number }

/** The team, locked, in the workspace the caller administers. */
async function lockTeam(tx: WorkspaceTransaction, actorId: string, teamId: string) {
  z.uuid().parse(teamId)
  const [team] = await tx.select({ id: teams.id, name: teams.name, workspaceId: teams.workspaceId }).from(teams).where(eq(teams.id, teamId)).for('update').limit(1)
  if (!team) throw new WorkspaceError('teamNotFound')
  await requireWorkspace(tx, team.workspaceId, actorId, true)
  return team
}

/**
 * Tasks are the team's issues that still exist; projects are the ones linked
 * only to this team (a project shared with another team just loses the link).
 */
async function teamContents(tx: WorkspaceTransaction, teamId: string) {
  const issueIds = (await tx.select({ id: teamIssues.issueId }).from(teamIssues).where(eq(teamIssues.teamId, teamId))).map(row => row.id)
  const linked = (await tx.select({ id: teamProjects.projectId }).from(teamProjects).where(eq(teamProjects.teamId, teamId))).map(row => row.id)
  const shared = linked.length ? new Set((await tx.select({ id: teamProjects.projectId }).from(teamProjects)
    .where(and(inArray(teamProjects.projectId, linked), ne(teamProjects.teamId, teamId)))).map(row => row.id)) : new Set<string>()
  return { issueIds, projectIds: linked.filter(id => !shared.has(id)) }
}

async function existingIssues(ids: string[]) {
  if (!ids.length) return []
  return (await db.select({ id: issues.id }).from(issues).where(inArray(issues.id, ids))).map(row => row.id)
}

/** What the delete dialog shows: 「删除团队和它的 N 个任务、M 个项目」. Admins only. */
export async function teamDeletionImpact(actorId: string, teamId: string): Promise<TeamDeletionImpact> {
  return workspaceDb.transaction(async tx => {
    const team = await lockTeam(tx, actorId, teamId)
    const { issueIds, projectIds } = await teamContents(tx, team.id)
    return { teamId: team.id, name: team.name, tasks: (await existingIssues(issueIds)).length, projects: projectIds.length }
  })
}

export interface TeamDeletion { deleted: { tasks: number; projects: number } }

/**
 * 删除团队 with its tasks and its own projects. The name must match. Tasks live
 * in the app database and are deleted in their own transaction first (the two
 * databases cannot share one); the team row stays locked meanwhile, and a
 * retry after a failure finishes the rest.
 */
export async function deleteTeamData(actorId: string, teamId: string, confirmName: string): Promise<TeamDeletion> {
  const typed = z.string().max(200).parse(confirmName).trim()
  return workspaceDb.transaction(async tx => {
    const team = await lockTeam(tx, actorId, teamId)
    if (typed !== team.name) throw new WorkspaceError('teamDeleteNameMismatch')
    await lockTeamRelations(tx)
    const { issueIds, projectIds } = await teamContents(tx, team.id)
    const tasks = await db.transaction(async main => {
      await main.delete(teamIssueCreateRequests).where(eq(teamIssueCreateRequests.teamId, team.id))
      await main.delete(teamIssuePromotions).where(eq(teamIssuePromotions.teamId, team.id))
      if (!issueIds.length) return 0
      return (await main.delete(issues).where(inArray(issues.id, issueIds)).returning({ id: issues.id })).length
    })
    await tx.delete(teamIssueCreateReceipts).where(eq(teamIssueCreateReceipts.teamId, team.id))
    await tx.delete(teamIssuePromotionReceipts).where(eq(teamIssuePromotionReceipts.teamId, team.id))
    await tx.delete(teamIssues).where(eq(teamIssues.teamId, team.id))
    await tx.delete(teamProjects).where(eq(teamProjects.teamId, team.id))
    let deletedProjects = 0
    if (projectIds.length) {
      await tx.delete(projectEvents).where(inArray(projectEvents.projectId, projectIds))
      deletedProjects = (await tx.delete(projects).where(inArray(projects.id, projectIds)).returning({ id: projects.id })).length
    }
    await tx.delete(teamMembers).where(eq(teamMembers.teamId, team.id))
    await tx.delete(teams).where(and(eq(teams.id, team.id), eq(teams.workspaceId, team.workspaceId)))
    return { deleted: { tasks, projects: deletedProjects } }
  })
}
