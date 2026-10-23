import { and, eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { teamIssues, teams } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'

type Db = Pick<NodePgDatabase<Record<string, unknown>>, 'select'>

/**
 * listIssues' team visibility for the relation picker (MIK-16), on an explicit database handle so
 * the route passes workspaceDb and the DB tests pass a rolled-back transaction.
 *
 * - publicIds: issues linked to any team in a workspace where the user is an active member
 *   (same as issueTeamScope(userId)).
 * - isVisible(ids): keeps an id unless it is linked to a team outside `workspaceId`'s teams the
 *   user can access (same rule the route applied with accessibleTeams + issueTeamScope).
 */
export async function issueSearchVisibility(db: Db, userId: string, workspaceId: string) {
  const allowed = await db.select({ id: teams.id, workspaceId: teams.workspaceId }).from(teams)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teams.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
  const allTeamIds = allowed.map(team => team.id)
  const workspaceTeamIds = new Set(allowed.filter(team => team.workspaceId === workspaceId).map(team => team.id))
  const publicIds = allTeamIds.length
    ? (await db.select({ issueId: teamIssues.issueId }).from(teamIssues).where(inArray(teamIssues.teamId, allTeamIds))).map(link => link.issueId)
    : []
  const isVisible = async (ids: string[]) => {
    if (!ids.length) return new Set<string>()
    const links = await db.select({ issueId: teamIssues.issueId, teamId: teamIssues.teamId }).from(teamIssues)
      .where(inArray(teamIssues.issueId, ids))
    const teamOf = new Map(links.map(link => [link.issueId, link.teamId]))
    return new Set(ids.filter(id => !teamOf.has(id) || workspaceTeamIds.has(teamOf.get(id)!)))
  }
  return { publicIds, isVisible }
}
