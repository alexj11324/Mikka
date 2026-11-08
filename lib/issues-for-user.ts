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

/**
 * `issueForUser` for many tasks in one read: the same visibility, token
 * workspace and deletion rules, with a fixed number of queries whatever the
 * count. `teams` is a legacy compatibility hint; each read checks current
 * canonical Workspace membership independently of that hint.
 */
export async function issuesForUser(reader: IssueReader, ids: readonly string[], includeDeleted = false, executor: Pick<typeof db, 'select'> = db, options: { withoutBody?: boolean; teams?: readonly TeamScope[] } = {}) {
  const wanted = [...new Set(ids)].filter(id => z.uuid().safeParse(id).success)
  const found = new Map<string, typeof issues.$inferSelect>()
  if (!wanted.length) return found
  const acting = actingContext.getStore()
  const workspaceId = typeof reader === 'string' ? (acting?.userId === reader ? acting.tokenWorkspaceId : undefined) : reader[tokenWorkspace]
  // Canonical tenant authorization does not consume Team naming/grouping rows.
  // The exact token/link consistency check below remains a separate read.
  const visibility = await issueVisibility(reader, includeDeleted, workspaceId, executor, { onlyIssueIds: wanted, withTeamLinks: false })
  const rows = options.withoutBody
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
    found.set(issue.id, issue as typeof issues.$inferSelect)
  }
  return found
}
