import 'server-only'
import { eq, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues, issueMembers } from '@/lib/db/schema'
import { issueTeamScope } from '@/lib/issue-team-access'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'

/** Resolve workspace membership in its own DB; never cross-join the two DBs.
 * No request/global cache: suspension/removal takes effect on the next read. */
export async function issueVisibility(userId: string, includeDeleted = false) {
  const candidates = await db.select({ id: issues.id }).from(issues).where(or(
    eq(issues.userId, userId),
    sql`exists (select 1 from ${issueMembers} where ${issueMembers.issueId} = ${issues.id} and ${issueMembers.userId} = ${issues.userId} and ${issueMembers.memberId} = ${userId})`,
  ))
  const links = await issueTeamScope(userId, candidates.map(row => row.id))
  // issueTeamScope includes candidate links even when membership is revoked.
  const allowed = await issueTeamScope(userId)
  const allowedIds = allowed.map(link => link.issueId)
  return { predicate: issueVisibilityPredicate(userId, { linkedIds: links.map(link => link.issueId), allowedIds }, includeDeleted), allowedIds }
}
