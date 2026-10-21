import 'server-only'
import { getSession } from '@/lib/session'
import { and, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { issues, issueMembers } from '@/lib/db/schema'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { readIssueMetadata } from '@/lib/issue-metadata'

export async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('请先登录。')
  return session.user
}
export async function requireIssueAccess(id: string, includeDeleted = false) {
  z.uuid().parse(id)
  const user = await requireUser()
  const access = await issueTeamAccess(id, user.id)
  if (access.linked && !access.allowed) throw new Error('任务不存在或没有访问权限。')
  const [row] = await db.select({ issue: issues }).from(issues)
    .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, user.id)))
    .where(and(eq(issues.id, id), access.allowed ? undefined : or(eq(issues.userId, user.id), eq(issueMembers.memberId, user.id)))).limit(1)
  if (!row || (!includeDeleted && readIssueMetadata(row.issue.content).deletedAt)) throw new Error('任务不存在或没有访问权限。')
  return { issue: row.issue, teamId: access.teamId, user }
}
