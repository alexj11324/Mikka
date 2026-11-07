import 'server-only'
import { db } from '@/lib/db'
import { issueTeamScope } from '@/lib/issue-team-access'
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
} = {}) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const workspaces = await activeTaskWorkspaces(reader, workspaceId)
  const workspaceIds = workspaces.map(workspace => workspace.id)
  // Team relations remain for numbering and grouping, never for tenant inference.
  const links = options.withTeamLinks === false ? [] : (await issueTeamScope(userId, [], { onlyIssueIds: options.onlyIssueIds, teams: options.teams, withTaskNumbers: options.withTaskNumbers }))
    .filter(link => workspaceIds.includes(link.workspaceId))
  const allowedIds = links.map(link => link.issueId)
  return { predicate: issueVisibilityPredicate(userId, { allowedIds, workspaceIds }, includeDeleted), allowedIds, links, workspaceIds }
}
