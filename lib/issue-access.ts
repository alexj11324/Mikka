import 'server-only'
import { and, eq, getTableColumns } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
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

type Issue = typeof issues.$inferSelect
type LockIssue = Pick<Issue, 'id' | 'userId' | 'workspaceId' | 'ownershipState' | 'scopeVersion' | 'content'>
type IssueAccess<T = Issue> = { issue: T; teamId: string | null }
type RequestIssueAccess<T = Issue> = IssueAccess<T> & { user: Awaited<ReturnType<typeof requireUser>> }

export async function requireUser() {
  // Explicit-user readers (including verified webhooks) do not need to
  // initialize session/OAuth state merely by importing this module.
  const { currentUser } = await import('@/lib/acting-user')
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
 * The internal lock projection keeps only scope fields and attrs; default callers retain the full row shape.
 */
export function requireIssueAccessWithoutBody(id: string, options: { projection: 'lock' }): Promise<RequestIssueAccess<LockIssue>>
export function requireIssueAccessWithoutBody(id: string): Promise<RequestIssueAccess>
export async function requireIssueAccessWithoutBody(id: string, options?: { projection: 'lock' }) {
  return options?.projection === 'lock' ? requireRequestIssue(id, false, 'lock') : requireRequestIssue(id, false, true)
}

function requireRequestIssue(id: string, includeDeleted: boolean, withoutBody: 'lock'): Promise<RequestIssueAccess<LockIssue>>
function requireRequestIssue(id: string, includeDeleted: boolean, withoutBody: boolean): Promise<RequestIssueAccess>
async function requireRequestIssue(id: string, includeDeleted: boolean, withoutBody: boolean | 'lock') {
  const user = await requireUser()
  const pinned = taskReaderScope(user).workspaceId
  // Only this server-side context may supply the entry membership proof. Token
  // principals still take issueVisibility's fresh scoped authorization path.
  // Locked callers independently recheck membership after waiting, or hold it
  // through their write; this proof never survives the current request.
  const verifiedWorkspaceId = pinned ? undefined : (await (await import('@/lib/workspace-access')).loadWorkspaceContext(undefined, user)).workspace.id
  const workspaceId = pinned ?? verifiedWorkspaceId!
  const reader = { ...user, [tokenWorkspace]: workspaceId, [enterprisePrincipal]: user[enterprisePrincipal] }
  const issue = withoutBody === 'lock'
    ? await findIssueForUser(reader, id, includeDeleted, db, 'lock', true, verifiedWorkspaceId)
    : await findIssueForUser(reader, id, includeDeleted, db, withoutBody, true, verifiedWorkspaceId)
  if (!issue) throw new ActionFailureError('issueNotFound')
  return { ...issue, user }
}

const { content: _content, ...issueColumnsWithoutBody } = getTableColumns(issues)
// Only lock-bound internal readers use this projection. They re-read all task
// data after acquiring the row lock; attrs retain the same deletion check here.
const issueLockColumns = { id: issues.id, userId: issues.userId, workspaceId: issues.workspaceId,
  ownershipState: issues.ownershipState, scopeVersion: issues.scopeVersion, content: issueAttrsContent }

function findIssueForUser(reader: IssueReader, id: string, includeDeleted: boolean, executor: Pick<typeof db, 'select'>, withoutBody: 'lock', withTeam?: boolean, verifiedWorkspaceId?: string): Promise<IssueAccess<LockIssue> | null>
function findIssueForUser(reader: IssueReader, id: string, includeDeleted: boolean, executor?: Pick<typeof db, 'select'>, withoutBody?: boolean, withTeam?: boolean, verifiedWorkspaceId?: string): Promise<IssueAccess | null>
async function findIssueForUser(reader: IssueReader, id: string, includeDeleted: boolean, executor: Pick<typeof db, 'select'> = db, withoutBody: boolean | 'lock' = false, withTeam = true, verifiedWorkspaceId?: string) {
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
  const [row] = withoutBody === 'lock'
    ? await executor.select({ issue: issueLockColumns }).from(issues).where(and(eq(issues.id, id), predicate)).limit(1)
    : withoutBody
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
