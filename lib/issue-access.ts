import 'server-only'
import { and, eq, getTableColumns } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { currentUser } from '@/lib/acting-user'
import { actingContext } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { issueTeamAccess } from '@/lib/issue-team-access'
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

async function findIssueForUser(reader: IssueReader, id: string, includeDeleted: boolean, executor: Pick<typeof db, 'select'> = db, withoutBody = false) {
  if (!z.uuid().safeParse(id).success) return null
  const userId = typeof reader === 'string' ? reader : reader.id
  // A bare id inside `actAs` for a token's owner keeps the token's scope (an API route running existing actions).
  const acting = actingContext.getStore()
  const workspaceId = typeof reader === 'string' ? (acting?.userId === reader ? acting.tokenWorkspaceId : undefined) : reader[tokenWorkspace]
  const access = await issueTeamAccess(id, userId)
  const visibility = await issueVisibility(reader, includeDeleted, workspaceId, executor, { onlyIssueIds: [id] })
  const [row] = withoutBody
    ? await executor.select({ issue: { ...issueColumnsWithoutBody, content: issueAttrsContent } }).from(issues).where(and(eq(issues.id, id), visibility.predicate)).limit(1)
    : await executor.select({ issue: issues }).from(issues).where(and(eq(issues.id, id), visibility.predicate)).limit(1)
  if (!row || (!includeDeleted && readIssueMetadata(row.issue.content).deletedAt)) return null
  // A workspace token reads its owner's workspace tasks only in that workspace, as its task list does.
  if (workspaceId && row.issue.scope === 'workspace' && access.linked && access.workspaceId !== workspaceId) return null
  return { issue: row.issue, teamId: access.teamId }
}

/** The issue this user can access; for callers without a session, like the Coordinator.
 * Pass an API route's session user, not its id, so a workspace token keeps its scope.
 * `withoutBody`: `content` holds only its attrs (the metadata), for callers that show a task's name and state. */
export async function issueForUser(reader: IssueReader, id: string, includeDeleted = false, executor: Pick<typeof db, 'select'> = db, options: { withoutBody?: boolean } = {}) {
  const result = await findIssueForUser(reader, id, includeDeleted, executor, options.withoutBody)
  return result?.issue ?? null
}
