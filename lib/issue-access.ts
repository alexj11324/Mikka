import 'server-only'
import { and, eq, getTableColumns, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { currentUser } from '@/lib/acting-user'
import { actingContext } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import type { TeamScope } from '@/lib/team-access'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { tokenWorkspace } from '@/lib/tokens/principal'

export async function requireUser() {
  const user = await currentUser()
  if (!user) throw new ActionFailureError('authRequired')
  return user
}

export async function requireIssueAccess(id: string, includeDeleted = false) {
  const user = await requireUser()
  const issue = await findIssueForUser(user, id, includeDeleted)
  if (!issue) throw new ActionFailureError('issueNotFound')
  return { ...issue, user }
}

/**
 * Like requireIssueAccess, without reading the task body: `content` holds only
 * its attrs (where the metadata lives). For callers that re-read the body under
 * a lock, or never need it; a full body is up to 250 KB of database egress.
 */
export async function requireIssueAccessWithoutBody(id: string) {
  const user = await requireUser()
  const issue = await findIssueForUser(user, id, false, db, true)
  if (!issue) throw new ActionFailureError('issueNotFound')
  return { ...issue, user }
}

const { content: _content, ...issueColumnsWithoutBody } = getTableColumns(issues)

async function findIssueForUser(reader: IssueReader, id: string, includeDeleted: boolean, executor: Pick<typeof db, 'select'> = db, withoutBody = false, withTeam = true) {
  if (!z.uuid().safeParse(id).success) return null
  const userId = typeof reader === 'string' ? reader : reader.id
  // A bare id inside `actAs` for a token's owner keeps the token's scope (an API route running existing actions).
  const acting = actingContext.getStore()
  const workspaceId = typeof reader === 'string' ? (acting?.userId === reader ? acting.tokenWorkspaceId : undefined) : reader[tokenWorkspace]
  // The team link is needed for the caller's team id or a token's workspace check; a plain session read skips it.
  const access = withTeam || workspaceId ? await issueTeamAccess(id, userId) : null
  const visibility = await issueVisibility(reader, includeDeleted, workspaceId, executor, { onlyIssueIds: [id] })
  const [row] = withoutBody
    ? await executor.select({ issue: { ...issueColumnsWithoutBody, content: issueAttrsContent } }).from(issues).where(and(eq(issues.id, id), visibility.predicate)).limit(1)
    : await executor.select({ issue: issues }).from(issues).where(and(eq(issues.id, id), visibility.predicate)).limit(1)
  if (!row || (!includeDeleted && readIssueMetadata(row.issue.content).deletedAt)) return null
  // A workspace token reads its owner's workspace tasks only in that workspace, as its task list does.
  if (workspaceId && row.issue.scope === 'workspace' && access?.linked && access.workspaceId !== workspaceId) return null
  return { issue: row.issue, teamId: access?.teamId ?? null }
}

/** The issue this user can access; for callers without a session, like the Coordinator.
 * Pass an API route's session user, not its id, so a workspace token keeps its scope.
 * `withoutBody`: `content` holds only its attrs (the metadata), for callers that show a task's name and state. */
export async function issueForUser(reader: IssueReader, id: string, includeDeleted = false, executor: Pick<typeof db, 'select'> = db, options: { withoutBody?: boolean } = {}) {
  const result = await findIssueForUser(reader, id, includeDeleted, executor, options.withoutBody, false)
  return result?.issue ?? null
}

/**
 * `issueForUser` for many tasks in one read: the same visibility, token
 * workspace and deletion rules, with a fixed number of queries whatever the
 * count. `teams`: a membership read made earlier in this same operation.
 */
export async function issuesForUser(reader: IssueReader, ids: readonly string[], includeDeleted = false, executor: Pick<typeof db, 'select'> = db, options: { withoutBody?: boolean; teams?: readonly TeamScope[] } = {}) {
  const wanted = [...new Set(ids)].filter(id => z.uuid().safeParse(id).success)
  const found = new Map<string, typeof issues.$inferSelect>()
  if (!wanted.length) return found
  const acting = actingContext.getStore()
  const workspaceId = typeof reader === 'string' ? (acting?.userId === reader ? acting.tokenWorkspaceId : undefined) : reader[tokenWorkspace]
  const visibility = await issueVisibility(reader, includeDeleted, workspaceId, executor, { onlyIssueIds: wanted, teams: options.teams })
  const rows = options.withoutBody
    ? await executor.select({ issue: { ...issueColumnsWithoutBody, content: issueAttrsContent } }).from(issues).where(and(inArray(issues.id, wanted), visibility.predicate))
    : await executor.select({ issue: issues }).from(issues).where(and(inArray(issues.id, wanted), visibility.predicate))
  // A workspace token reads its owner's workspace tasks only in that workspace (as findIssueForUser).
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
