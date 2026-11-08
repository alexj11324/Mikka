import 'server-only'
import { and, getTableColumns, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { actingContext } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { teamIssues } from '@/lib/db/team-schema'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { readIssueMetadata } from '@/lib/issue-metadata'
import type { TeamScope } from '@/lib/team-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { workspaceDb } from '@/lib/workspace-db'

// Its own module, beside lib/issue-access.ts: unit tests stub that module with only the names they use.
const { content: _content, ...issueColumnsWithoutBody } = getTableColumns(issues)
const citationColumns = { id: issues.id, userId: issues.userId, scope: issues.scope, title: issues.title,
  shortTitle: issues.shortTitle, shortTitleFrom: issues.shortTitleFrom, status: issues.status, content: issueAttrsContent }
type Issue = typeof issues.$inferSelect
type CitationIssue = Pick<Issue, keyof typeof citationColumns>
type ReadOptions = { withoutBody?: boolean; teams?: readonly TeamScope[]; identifierTeams?: Map<string, { key: string; number: number }>; withTeamLinks?: false; projection?: 'citation' }
type Executor = Pick<typeof db, 'select'>

/**
 * `issueForUser` for many tasks in one read: the same visibility, token
 * workspace and deletion rules, with a fixed number of queries whatever the
 * count. `teams`: a membership read made earlier in this same operation.
 * `withTeamLinks: false` skips display/grouping links only; the token's
 * independent exact-link mismatch check below still reads current links.
 * `projection: 'citation'` keeps that same gate and returns only citation data.
 */
export function issuesForUser(reader: IssueReader, ids: readonly string[], includeDeleted: boolean | undefined, executor: Executor | undefined, options: ReadOptions & { projection: 'citation' }): Promise<Map<string, CitationIssue>>
export function issuesForUser(reader: IssueReader, ids: readonly string[], includeDeleted?: boolean, executor?: Executor, options?: ReadOptions & { projection?: never }): Promise<Map<string, Issue>>
export async function issuesForUser(reader: IssueReader, ids: readonly string[], includeDeleted = false, executor: Executor = db, options: ReadOptions = {}) {
  const wanted = [...new Set(ids)].filter(id => z.uuid().safeParse(id).success)
  const found = new Map<string, Issue | CitationIssue>()
  if (!wanted.length) return found
  const acting = actingContext.getStore()
  const workspaceId = typeof reader === 'string' ? (acting?.userId === reader ? acting.tokenWorkspaceId : undefined) : reader[tokenWorkspace]
  const visibility = await issueVisibility(reader, includeDeleted, workspaceId, executor, {
    onlyIssueIds: wanted, teams: options.teams, withTeamLinks: options.withTeamLinks, ...(options.identifierTeams ? { withIdentifierTeams: true } : {}),
  })
  if (options.identifierTeams && visibility.taskTeams) {
    // This operation's complete later read can also remove an earlier link.
    for (const id of wanted) options.identifierTeams.delete(id)
    for (const [id, team] of visibility.taskTeams) options.identifierTeams.set(id, team)
  }
  const rows = options.projection === 'citation'
    ? await executor.select({ issue: citationColumns }).from(issues).where(and(inArray(issues.id, wanted), visibility.predicate))
    : options.withoutBody
      ? await executor.select({ issue: { ...issueColumnsWithoutBody, content: issueAttrsContent } }).from(issues).where(and(inArray(issues.id, wanted), visibility.predicate))
      : await executor.select({ issue: issues }).from(issues).where(and(inArray(issues.id, wanted), visibility.predicate))
  // A workspace token reads its owner's workspace tasks only in that workspace (as issueForUser in lib/issue-access.ts).
  const links = workspaceId && rows.some(row => row.issue.scope === 'workspace')
    ? new Map((await workspaceDb.select({ issueId: teamIssues.issueId, workspaceId: teamIssues.workspaceId }).from(teamIssues)
      .where(inArray(teamIssues.issueId, rows.map(row => row.issue.id)))).map(link => [link.issueId, link.workspaceId]))
    : new Map<string, string>()
  for (const { issue } of rows) {
    if (!includeDeleted && readIssueMetadata(issue.content).deletedAt) continue
    const linked = links.get(issue.id)
    if (workspaceId && issue.scope === 'workspace' && linked && linked !== workspaceId) continue
    found.set(issue.id, issue)
  }
  return found
}
