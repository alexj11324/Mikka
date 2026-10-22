import { and, eq, or } from 'drizzle-orm'
import { issueMembers, issues } from './db/schema'

/** Issue rows owned by the same person that this user owns or is a member of. */
export function issueOwnerScope(userId: string, ownerId: string) {
  return and(eq(issues.userId, ownerId), or(eq(issues.userId, userId), eq(issueMembers.memberId, userId)))
}
