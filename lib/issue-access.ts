import 'server-only'
import { and, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { currentUser } from '@/lib/acting-user'
import { db } from '@/lib/db'
import { issues, issueMembers } from '@/lib/db/schema'
import { readIssueMetadata } from '@/lib/issue-metadata'

export async function requireUser() {
  const user = await currentUser()
  if (!user) throw new ActionFailureError('authRequired')
  return user
}
export async function requireIssueAccess(id: string, includeDeleted = false) {
  const user = await requireUser()
  const issue = await issueForUser(user.id, id, includeDeleted)
  if (!issue) throw new ActionFailureError('issueNotFound')
  return { issue, user }
}

/** The issue if this person owns it or is a member of it; for callers with no session, like the Coordinator. */
export async function issueForUser(userId: string, id: string, includeDeleted = false) {
  if (!z.uuid().safeParse(id).success) return null
  const [row] = await db.select({ issue: issues }).from(issues)
    .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(eq(issues.id, id), or(eq(issues.userId, userId), eq(issueMembers.memberId, userId)))).limit(1)
  if (!row || (!includeDeleted && readIssueMetadata(row.issue.content).deletedAt)) return null
  return row.issue
}
