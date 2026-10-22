import 'server-only'
import { headers } from 'next/headers'
import { and, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { issues, issueMembers } from '@/lib/db/schema'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { readIssueMetadata } from '@/lib/issue-metadata'

export async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user
}

export async function requireIssueAccess(id: string, includeDeleted = false) {
  const user = await requireUser()
  const issue = await findIssueForUser(user.id, id, includeDeleted)
  if (!issue) throw new ActionFailureError('issueNotFound')
  return { ...issue, user }
}

async function findIssueForUser(userId: string, id: string, includeDeleted: boolean) {
  if (!z.uuid().safeParse(id).success) return null
  const access = await issueTeamAccess(id, userId)
  if (access.linked && !access.allowed) return null
  const [row] = await db.select({ issue: issues }).from(issues)
    .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(eq(issues.id, id), access.allowed ? undefined : or(eq(issues.userId, userId), eq(issueMembers.memberId, userId)))).limit(1)
  if (!row || (!includeDeleted && readIssueMetadata(row.issue.content).deletedAt)) return null
  return { issue: row.issue, teamId: access.teamId }
}

/** The issue this user can access; for callers without a session, like the Coordinator. */
export async function issueForUser(userId: string, id: string, includeDeleted = false) {
  const result = await findIssueForUser(userId, id, includeDeleted)
  return result?.issue ?? null
}
