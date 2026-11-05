import 'server-only'
import { and, asc, eq, gt, inArray, or } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { accessibleTeamScopes, type TeamScope } from '@/lib/team-access'

/**
 * Team links of `ids` and of every team the user can access. With
 * `onlyIssueIds`, only links of those issues are read: the same answer for
 * them as the full read, for callers that already know which issues they ask
 * about (an empty list reads nothing). Without it every accessible team's
 * links are read, as list views need.
 */
export async function issueTeamScope(userId: string, ids: string[] = [], options: {
  onlyIssueIds?: readonly string[]
  /** Membership read earlier in this same operation; never retain across requests. */
  teams?: readonly TeamScope[]
} = {}) {
  const only = options.onlyIssueIds
  if (only && !only.length) return []
  const allowed = options.teams ?? await accessibleTeamScopes(userId)
  const teamIds = allowed.map(team => team.id)
  if (!ids.length && !teamIds.length) return []
  if (!ids.length) {
    // These pairs came from this operation's membership read. Enforce both
    // columns in SQL; a team id alone must not admit a foreign-workspace link.
    const workspaceByTeam = new Map(allowed.map(team => [team.id, team.workspaceId]))
    const pairs = or(...allowed.map(team => and(eq(teamIssues.teamId, team.id), eq(teamIssues.workspaceId, team.workspaceId))))
    const links: { issueId: string; teamId: string; workspaceId: string }[] = []
    let after: string | undefined
    for (;;) {
      const page = await workspaceDb.select({ issueId: teamIssues.issueId, teamId: teamIssues.teamId }).from(teamIssues)
        .where(and(pairs, only ? inArray(teamIssues.issueId, [...only]) : undefined, after ? gt(teamIssues.issueId, after) : undefined))
        .orderBy(asc(teamIssues.issueId)).limit(128)
      for (const link of page) links.push({ ...link, workspaceId: workspaceByTeam.get(link.teamId)! })
      if (page.length < 128) return links
      after = page[page.length - 1].issueId
    }
  }
  // Explicit ids also include revoked/other-workspace links, which token
  // scoping needs to reject them. Keep that full projection and contract.
  const links = await workspaceDb.select({ issueId: teamIssues.issueId, teamId: teamIssues.teamId, workspaceId: teamIssues.workspaceId }).from(teamIssues)
    .where(and(only ? inArray(teamIssues.issueId, [...only]) : undefined, or(ids.length ? inArray(teamIssues.issueId, ids) : undefined, teamIds.length ? inArray(teamIssues.teamId, teamIds) : undefined)))
  return links.filter(link => ids.includes(link.issueId) || allowed.some(team => team.id === link.teamId && team.workspaceId === link.workspaceId))
}
export async function issueTeamAccess(issueId: string, userId: string) {
  const [link] = await workspaceDb.select().from(teamIssues).where(eq(teamIssues.issueId, issueId)).limit(1)
  if (!link) return { teamId: null, workspaceId: null, allowed: false, linked: false }
  const [member] = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, link.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'))).limit(1)
  return { teamId: link.teamId, workspaceId: link.workspaceId, allowed: !!member, linked: true }
}
