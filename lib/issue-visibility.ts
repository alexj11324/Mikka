import 'server-only'
import { db } from '@/lib/db'
import { issueTeamScope, numberedIssueTeamScope } from '@/lib/issue-team-access'
import type { TeamScope } from '@/lib/team-access'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { activeTaskWorkspaces } from '@/lib/task-workspace'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'

/** A session principal or an API principal pinned to an authenticated workspace. */
export type IssueReader = string | { id: string; [tokenWorkspace]?: string; [enterprisePrincipal]?: EnterprisePrincipal }

export async function issueVisibility(reader: IssueReader, includeDeleted = false, workspaceId?: string, _executor: Pick<typeof db, 'select'> = db, options: {
  onlyIssueIds?: readonly string[]
  teams?: readonly TeamScope[]
  withTaskNumbers?: boolean
  /** Pure authorization reads do not need synchronization metadata. */
  withTeamLinks?: boolean
  /** Complete identifier dependencies, only for the exact bounded ids. */
  withIdentifierTeams?: boolean
} = {}) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const only = options.onlyIssueIds
  if (options.withIdentifierTeams && !only) throw new Error('Identifier team reads require bounded issue ids')
  const workspaces = await activeTaskWorkspaces(reader, workspaceId)
  const workspaceIds = workspaces.map(workspace => workspace.id)
  if (options.withIdentifierTeams && options.teams?.length === 0) {
    // This operation already proved there are no accessible teams, but the
    // naming read must still preserve an existing revoked or unlinked label.
    // Tenant authorization remains the fresh workspace proof above.
    const { teamNumbers } = await import('@/lib/task-identifier-server')
    const allowedIds: string[] = []
    return {
      predicate: issueVisibilityPredicate(userId, { allowedIds, workspaceIds }, includeDeleted),
      allowedIds, links: [], workspaceIds, taskTeams: await teamNumbers([...only!]),
    }
  }
  const numbered = options.withIdentifierTeams ? await numberedIssueTeamScope(userId, only!, { teams: options.teams }) : undefined
  // Team relations remain for numbering and grouping, never for tenant inference.
  const links = options.withTeamLinks === false ? [] : (numbered?.allowed ?? await issueTeamScope(userId, [], { onlyIssueIds: only, teams: options.teams, withTaskNumbers: options.withTaskNumbers }))
    .filter(link => workspaceIds.includes(link.workspaceId))
  const allowedIds = links.map(link => link.issueId)
  return { predicate: issueVisibilityPredicate(userId, { allowedIds, workspaceIds }, includeDeleted), allowedIds, links, workspaceIds,
    ...(numbered ? { taskTeams: numbered.taskTeams } : {}) }
}
