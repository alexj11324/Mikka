import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm'
import { issueMembers, issues } from './db/schema'

export interface IssueVisibilityLinks { linkedIds: string[]; allowedIds: string[] }

/** Personal scope beats legacy invitations/team links. Linked workspace tasks
 * require a live workspace membership, even for a stale owner/invitee. */
export function issueVisibilityPredicate(userId: string, links: IssueVisibilityLinks, includeDeleted = false) {
  const invited = sql`exists (select 1 from ${issueMembers} where ${issueMembers.issueId} = ${issues.id} and ${issueMembers.userId} = ${issues.userId} and ${issueMembers.memberId} = ${userId})`
  return and(
    includeDeleted ? undefined : sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`,
    or(
      and(eq(issues.scope, 'personal'), eq(issues.userId, userId)),
      and(eq(issues.scope, 'workspace'), or(
        links.allowedIds.length ? inArray(issues.id, links.allowedIds) : undefined,
        and(or(eq(issues.userId, userId), invited), links.linkedIds.length ? notInArray(issues.id, links.linkedIds) : undefined),
      )),
    ),
  )!
}
