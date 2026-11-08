import 'server-only'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { actingContext } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { issues, issueMembers } from '@/lib/db/schema'
import { issueTeamScope, numberedIssueTeamScope } from '@/lib/issue-team-access'
import type { TeamScope } from '@/lib/team-access'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { isPersonalWorkspace } from '@/lib/tokens/scope'

/** A user id, or an API user whose personal access token is pinned to one workspace. */
export type IssueReader = string | { id: string; [tokenWorkspace]?: string }

/** The workspace a reader's access token is pinned to: on an API user, or, for a bare id, the `actAs` running for it. */
function readerTokenWorkspace(reader: IssueReader) {
  if (typeof reader !== 'string') return reader[tokenWorkspace]
  const acting = actingContext.getStore()
  return acting?.userId === reader ? acting.tokenWorkspaceId : undefined
}

/** Resolve workspace membership in its own DB; never cross-join the two DBs.
 * No cross-request cache: suspension/removal takes effect on the next read. */
/** `onlyIssueIds`: the caller asks only about these issues (its query filters by them), so only their
 * team links are read; the predicate is exact for them and must not be used for any other issue. */
export async function issueVisibility(reader: IssueReader, includeDeleted = false, workspaceId?: string, executor: Pick<typeof db, 'select'> = db, options: {
  onlyIssueIds?: readonly string[]
  /** Reuse only a membership read made by this same operation. */
  teams?: readonly TeamScope[]
  withTaskNumbers?: boolean
  /** Complete identifier dependencies, only for the exact bounded ids. */
  withIdentifierTeams?: boolean
} = {}) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const token = readerTokenWorkspace(reader)
  const only = options.onlyIssueIds
  if (options.withIdentifierTeams && !only) throw new Error('Identifier team reads require bounded issue ids')
  if (options.withIdentifierTeams && !token && options.teams?.length === 0) {
    // No accessible teams does not prove these issues are unlinked. Reuse the
    // exact naming read without reloading membership or unused complete links.
    const { teamNumbers } = await import('@/lib/task-identifier-server')
    const allowedIds: string[] = []
    return {
      predicate: issueVisibilityPredicate(userId, { allowedIds }, includeDeleted),
      allowedIds,
      links: [],
      taskTeams: await teamNumbers([...only!]),
    }
  }
  const numbered = options.withIdentifierTeams ? await numberedIssueTeamScope(userId, only!, { teams: options.teams }) : undefined
  const allowed = numbered?.allowed ?? await issueTeamScope(userId, [], { onlyIssueIds: only, teams: options.teams, withTaskNumbers: options.withTaskNumbers })
  const scopeWorkspace = token ?? workspaceId
  const allowedIds = allowed.filter(link => !scopeWorkspace || link.workspaceId === scopeWorkspace).map(link => link.issueId)
  const predicate = issueVisibilityPredicate(userId, { allowedIds }, includeDeleted)
  if (!token) return { predicate, allowedIds, links: allowed, ...(numbered ? { taskTeams: numbered.taskTeams } : {}) }
  // Only a token's workspace scoping reads the reader's own and shared tasks' links; a browser session skips the lookup.
  const candidates = numbered || (only && !only.length) ? [] : await executor.select({ id: issues.id }).from(issues).where(and(only ? inArray(issues.id, [...only]) : undefined, or(
    eq(issues.userId, userId),
    sql`exists (select 1 from ${issueMembers} where ${issueMembers.issueId} = ${issues.id} and ${issueMembers.userId} = ${issues.userId} and ${issueMembers.memberId} = ${userId})`,
  )))
  // issueTeamScope includes candidate links even when membership is revoked.
  const links = numbered?.links ?? await issueTeamScope(userId, candidates.map(row => row.id), { onlyIssueIds: only, teams: options.teams })
  // The workspace is the tenant (decision 0231): a token for a team workspace reaches only tasks linked to it,
  // never the owner's personal or unlinked tasks. The personal workspace's token keeps those, but not a
  // workspace task linked elsewhere (as lib/issue-access.ts). Browser sessions are unchanged.
  const ids = (match: (workspaceId: string) => boolean) => [...new Set([...links, ...allowed].filter(link => match(link.workspaceId)).map(link => link.issueId))]
  if (await isPersonalWorkspace(userId, token)) {
    const elsewhere = ids(workspace => workspace !== token)
    return { predicate: elsewhere.length ? and(predicate, sql`not (${issues.scope} = 'workspace' and ${inArray(issues.id, elsewhere)})`)! : predicate, allowedIds, links: allowed, ...(numbered ? { taskTeams: numbered.taskTeams } : {}) }
  }
  const linked = ids(workspace => workspace === token)
  return { predicate: and(predicate, linked.length ? inArray(issues.id, linked) : sql`false`)!, allowedIds, links: allowed, ...(numbered ? { taskTeams: numbered.taskTeams } : {}) }
}
