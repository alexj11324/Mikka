import 'server-only'
import { and, asc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues, teams } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { accessibleTeamScopes, type TeamScope } from '@/lib/team-access'

type IssueTeamLink = { issueId: string; teamId: string; workspaceId: string; key?: string | null; number?: number }

/** Keep the existing 128-link page in one transport row. Packing the two
 * binary UUIDs together offsets the identifier fields even for singleton
 * teams with long keys, without growing unchanged-list database traffic. */
async function numberedLinkPage(predicate: SQL | undefined) {
  const page = workspaceDb.select({ issueId: teamIssues.issueId, teamId: teamIssues.teamId, number: teamIssues.number }).from(teamIssues)
    .where(predicate).orderBy(asc(teamIssues.issueId)).limit(128).as('scope_links')
  const [packed] = await workspaceDb.select({
    tasks: sql<[string, string | null, number][]>`coalesce(jsonb_agg(jsonb_build_array(
      encode(uuid_send(scope_links."issueId") || uuid_send(scope_links."teamId"), 'base64'),
      ${teams.identifier}, scope_links.number
    ) order by scope_links."issueId"), '[]'::jsonb)`,
  }).from(page).leftJoin(teams, eq(teams.id, page.teamId))
  return packed.tasks.map(([ids, key, number]) => {
    const hex = Buffer.from(ids, 'base64').toString('hex')
    const uuid = (offset: number) => `${hex.slice(offset, offset + 8)}-${hex.slice(offset + 8, offset + 12)}-${hex.slice(offset + 12, offset + 16)}-${hex.slice(offset + 16, offset + 20)}-${hex.slice(offset + 20, offset + 32)}`
    return { issueId: uuid(0), teamId: uuid(32), key, number }
  })
}

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
  /** The list reuses these identifier dependencies for row cursors and labels. */
  withTaskNumbers?: boolean
} = {}): Promise<IssueTeamLink[]> {
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
    const links: IssueTeamLink[] = []
    let after: string | undefined
    for (;;) {
      const predicate = and(pairs, only ? inArray(teamIssues.issueId, [...only]) : undefined, after ? gt(teamIssues.issueId, after) : undefined)
      const page = options.withTaskNumbers ? await numberedLinkPage(predicate)
        : await workspaceDb.select({ issueId: teamIssues.issueId, teamId: teamIssues.teamId }).from(teamIssues)
          .where(predicate).orderBy(asc(teamIssues.issueId)).limit(128)
      for (const link of page) links.push({ ...link, workspaceId: workspaceByTeam.get(link.teamId)! })
      if (page.length < 128) return links
      after = page[page.length - 1].issueId
    }
  }
  // Explicit ids also include revoked/other-workspace links, which token
  // scoping needs to reject them. Keep that full projection and contract.
  const columns = { issueId: teamIssues.issueId, teamId: teamIssues.teamId, workspaceId: teamIssues.workspaceId }
  const predicate = and(only ? inArray(teamIssues.issueId, [...only]) : undefined, or(ids.length ? inArray(teamIssues.issueId, ids) : undefined, teamIds.length ? inArray(teamIssues.teamId, teamIds) : undefined))
  const links = options.withTaskNumbers
    ? await workspaceDb.select({ ...columns, number: teamIssues.number,
      key: sql<string | null>`(select local_team.identifier from mikka_teams local_team where local_team.id = mikka_team_issues."teamId")`,
    }).from(teamIssues).where(predicate)
    : await workspaceDb.select(columns).from(teamIssues).where(predicate)
  return links.filter(link => ids.includes(link.issueId) || allowed.some(team => team.id === link.teamId && team.workspaceId === link.workspaceId))
}
export async function issueTeamAccess(issueId: string, userId: string) {
  const [link] = await workspaceDb.select().from(teamIssues).where(eq(teamIssues.issueId, issueId)).limit(1)
  if (!link) return { teamId: null, workspaceId: null, allowed: false, linked: false }
  const [member] = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, link.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'))).limit(1)
  return { teamId: link.teamId, workspaceId: link.workspaceId, allowed: !!member, linked: true }
}
