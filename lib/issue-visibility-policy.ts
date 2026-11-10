import { and, eq, inArray, sql } from 'drizzle-orm'
import { issues } from './db/schema'
import { resourceAccessPredicate } from './resource-access/predicate'

export interface IssueVisibilityLinks { allowedIds: string[]; workspaceIds?: readonly string[] }

/** Tenant authority is mandatory, including for the task's creator. Legacy
 * scope, team links and invitations are not alternate authorization sources. */
export function issueVisibilityPredicate(userId: string, links: IssueVisibilityLinks, includeDeleted = false) {
  return and(
    includeDeleted ? undefined : sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`,
    eq(issues.ownershipState, 'bound'),
    links.workspaceIds?.length ? inArray(issues.workspaceId, [...links.workspaceIds]) : sql`false`,
    resourceAccessPredicate(userId, issues.workspaceId, 'task', issues.id),
  )!
}
