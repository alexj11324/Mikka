import 'server-only'
import { headers } from 'next/headers'
import { and, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { issues, issueMembers } from '@/lib/db/schema'

export async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user
}
export async function requireIssueAccess(id: string) {
  if (!z.uuid().safeParse(id).success) throw new ActionFailureError('issueNotFound')
  const user = await requireUser()
  const [row] = await db.select({ issue: issues }).from(issues)
    .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, user.id)))
    .where(and(eq(issues.id, id), or(eq(issues.userId, user.id), eq(issueMembers.memberId, user.id)))).limit(1)
  if (!row) throw new ActionFailureError('issueNotFound')
  return { issue: row.issue, user }
}
