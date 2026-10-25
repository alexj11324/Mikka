import { appendAudit } from '@/lib/audit/store'
import { pool } from '@/lib/db'
import 'server-only'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { currentUser } from '@/lib/acting-user'
import { db } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { issues } from '@/lib/db/schema'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { readIssueMetadata } from '@/lib/issue-metadata'

export async function requireUser() {
  const user = await currentUser()
  if (!user) throw new ActionFailureError('authRequired')
  return user
}

export async function requireIssueAccess(id: string, includeDeleted = false) {
  const user = await requireUser()
  const issue = await findIssueForUser(user.id, id, includeDeleted)
  if (!issue) {
    await appendAudit(pool, `personal:${user.id}`, { actorId: user.id, actorType: 'human', resourceId: 'issue', action: 'authorization.denied', outcome: 'denied', reason: 'issue_access_denied' })
    throw new ActionFailureError('issueNotFound')
  }
  return { ...issue, user }
}

async function findIssueForUser(userId: string, id: string, includeDeleted: boolean, executor: Pick<typeof db, 'select'> = db, workspaceExecutor: Pick<typeof workspaceDb, 'select'> = workspaceDb) {
  if (!z.uuid().safeParse(id).success) return null
  const [row] = await executor.select({ issue: issues }).from(issues)
    .where(eq(issues.id, id)).limit(1)
  if (!row) return null
  // Keep the baseline linked-workspace execution gate, including stale links
  // on owner-personal tasks. Run history visibility is a separate read policy.
  const access = await issueTeamAccess(id, userId, workspaceExecutor)
  if (access.linked && !access.allowed) return null
  // Personal scope never inherits invitations or stale team links.
  if (row.issue.scope === 'personal') {
    if (row.issue.userId !== userId) return null
    if (!includeDeleted && readIssueMetadata(row.issue.content).deletedAt) return null
    return { issue: row.issue, teamId: null }
  }
  // Preserve current execution authority and supplied transaction connections.
  if (!access.linked && row.issue.userId !== userId) return null
  if (!row || (!includeDeleted && readIssueMetadata(row.issue.content).deletedAt)) return null
  return { issue: row.issue, teamId: access.teamId }
}

/** The issue this user can access; for callers without a session, like the Coordinator. */
export async function issueForUser(userId: string, id: string, includeDeleted = false, executor: Pick<typeof db, 'select'> = db, workspaceExecutor: Pick<typeof workspaceDb, 'select'> = workspaceDb) {
  const result = await findIssueForUser(userId, id, includeDeleted, executor, workspaceExecutor)
  return result?.issue ?? null
}
