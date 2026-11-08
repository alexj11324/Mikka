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
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { taskReaderScope } from '@/lib/task-workspace'
import { enterprisePrincipal } from '@/lib/enterprise/principal'

export async function requireUser() {
  const user = await currentUser()
  if (!user) throw new ActionFailureError('authRequired')
  return user
}

export async function requireIssueAccess(id: string, includeDeleted = false) {
  return requireRequestIssue(id, includeDeleted, false)
}

/**
 * Like requireIssueAccess, without reading the task body: `content` holds only
 * its attrs (where the metadata lives). For callers that re-read the body under
 * a lock, or never need it; a full body is up to 250 KB of database egress.
 */
export async function requireIssueAccessWithoutBody(id: string) {
  return requireRequestIssue(id, false, true)
}

async function requireRequestIssue(id: string, includeDeleted: boolean, withoutBody: boolean) {
  const user = await requireUser()
  const pinned = taskReaderScope(user).workspaceId
  // Only this server-side context may supply the entry membership proof. Token
  // principals still take issueVisibility's fresh scoped authorization path.
  // Locked callers independently recheck membership after waiting, or hold it
  // through their write; this proof never survives the current request.
  const verifiedWorkspaceId = pinned ? undefined : (await (await import('@/lib/workspace-access')).loadWorkspaceContext(undefined, user)).workspace.id
  const workspaceId = pinned ?? verifiedWorkspaceId!
  const issue = await findIssueForUser({ ...user, [tokenWorkspace]: workspaceId, [enterprisePrincipal]: user[enterprisePrincipal] }, id, includeDeleted, db, withoutBody, true, verifiedWorkspaceId)
  if (!issue) throw new ActionFailureError('issueNotFound')
  return { ...issue, user }
}

const { content: _content, ...issueColumnsWithoutBody } = getTableColumns(issues)

async function findIssueForUser(reader: IssueReader, id: string, includeDeleted: boolean, executor: Pick<typeof db, 'select'> = db, withoutBody = false, withTeam = true, verifiedWorkspaceId?: string) {
  if (!z.uuid().safeParse(id).success) return null
  const userId = typeof reader === 'string' ? reader : reader.id
  // A bare id inside `actAs` for a token's owner keeps the token's scope (an API route running existing actions).
  const acting = actingContext.getStore()
  const workspaceId = typeof reader === 'string' ? (acting?.userId === reader ? acting.tokenWorkspaceId : undefined) : reader[tokenWorkspace]
  // The team link is needed for the caller's team id or a token's workspace check; a plain session read skips it.
  const access = withTeam || workspaceId ? await issueTeamAccess(id, userId) : null
  const predicate = verifiedWorkspaceId && verifiedWorkspaceId === workspaceId
    ? issueVisibilityPredicate(userId, { allowedIds: [], workspaceIds: [verifiedWorkspaceId] }, includeDeleted)
    : (await issueVisibility(reader, includeDeleted, workspaceId, executor, { onlyIssueIds: [id], withTeamLinks: false })).predicate
  const [row] = withoutBody
    ? await executor.select({ issue: { ...issueColumnsWithoutBody, content: issueAttrsContent } }).from(issues).where(and(eq(issues.id, id), predicate)).limit(1)
    : await executor.select({ issue: issues }).from(issues).where(and(eq(issues.id, id), predicate)).limit(1)
  if (!row || (!includeDeleted && readIssueMetadata(row.issue.content).deletedAt)) return null
  // A workspace token reads its owner's workspace tasks only in that workspace, as its task list does.
  if (workspaceId && row.issue.workspaceId !== workspaceId) return null
  if (access?.linked && access.workspaceId !== row.issue.workspaceId) return null
  return { issue: row.issue, teamId: access?.teamId ?? null }
}

/** The issue this user can access; for callers without a session, like the Coordinator.
 * Pass an API route's session user, not its id, so a workspace token keeps its scope.
 * `withoutBody`: `content` holds only its attrs (the metadata), for callers that show a task's name and state. */
export async function issueForUser(reader: IssueReader, id: string, includeDeleted = false, executor: Pick<typeof db, 'select'> = db, options: { withoutBody?: boolean } = {}) {
  const result = await findIssueForUser(reader, id, includeDeleted, executor, options.withoutBody, false)
  return result?.issue ?? null
}

/** Internal detail readers reuse this operation's exact team-link lookup for
 * numbering. A missing team is display metadata, never tenant authority. */
export async function issueAccessForUser(reader: IssueReader, id: string, includeDeleted = false, executor: Pick<typeof db, 'select'> = db, options: { withoutBody?: boolean } = {}) {
  return findIssueForUser(reader, id, includeDeleted, executor, options.withoutBody, true)
}
