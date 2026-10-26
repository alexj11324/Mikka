import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { currentUser } from '@/lib/acting-user'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { issueVisibility } from '@/lib/issue-visibility'
import { readIssueMetadata } from '@/lib/issue-metadata'

export async function requireUser() {
  const user = await currentUser()
  if (!user) throw new ActionFailureError('authRequired')
  return user
}

export async function requireIssueAccess(id: string, includeDeleted = false) {
  const user = await requireUser()
  const issue = await findIssueForUser(user.id, id, includeDeleted)
  if (!issue) throw new ActionFailureError('issueNotFound')
  return { ...issue, user }
}

async function findIssueForUser(userId: string, id: string, includeDeleted: boolean, executor: Pick<typeof db, 'select'> = db) {
  if (!z.uuid().safeParse(id).success) return null
  const access = await issueTeamAccess(id, userId)
  const visibility = await issueVisibility(userId, includeDeleted)
  const [row] = await executor.select({ issue: issues }).from(issues)
    .where(and(eq(issues.id, id), visibility.predicate)).limit(1)
  if (!row || (!includeDeleted && readIssueMetadata(row.issue.content).deletedAt)) return null
  return { issue: row.issue, teamId: access.teamId }
}

/** The issue this user can access; for callers without a session, like the Coordinator. */
export async function issueForUser(userId: string, id: string, includeDeleted = false, executor: Pick<typeof db, 'select'> = db) {
  const result = await findIssueForUser(userId, id, includeDeleted, executor)
  return result?.issue ?? null
}
