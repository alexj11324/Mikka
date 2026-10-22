import 'server-only'
import { and, eq, inArray, or } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { accessibleTeams } from '@/lib/team-access'

export async function issueTeamScope(userId: string, ids: string[] = []) {
  const allowed = await accessibleTeams(userId)
  const teamIds = allowed.map(team => team.id)
  if (!ids.length && !teamIds.length) return []
  return workspaceDb.select().from(teamIssues).where(or(ids.length ? inArray(teamIssues.issueId, ids) : undefined, teamIds.length ? inArray(teamIssues.teamId, teamIds) : undefined))
}
export async function issueTeamAccess(issueId: string, userId: string) {
  const [link] = await workspaceDb.select().from(teamIssues).where(eq(teamIssues.issueId, issueId)).limit(1)
  if (!link) return { teamId: null, allowed: false, linked: false }
  const [member] = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, link.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'))).limit(1)
  return { teamId: link.teamId, allowed: !!member, linked: true }
}
