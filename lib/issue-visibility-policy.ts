import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { issues } from './db/schema'

export interface IssueVisibilityLinks { linkedIds: string[]; allowedIds: string[] }

/** Owners retain full access. Nonowners need a workspace-scoped task linked
 * to a workspace where they are active; legacy invitations never grant personal
 * access or cross-workspace access to an unlinked task. */
export function issueVisibilityPredicate(userId: string, links: IssueVisibilityLinks, includeDeleted = false) {
  return and(
    includeDeleted ? undefined : sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`,
    or(
      eq(issues.userId, userId),
      and(eq(issues.scope, 'workspace'), links.allowedIds.length ? inArray(issues.id, links.allowedIds) : sql`false`),
    ),
  )!
}
