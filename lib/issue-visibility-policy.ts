import { and, eq, inArray, sql } from 'drizzle-orm'
import { issues } from './db/schema'

export interface IssueVisibilityLinks { allowedIds: string[]; workspaceIds?: readonly string[] }

/** Tenant authority is mandatory, including for the task's creator. Legacy
 * scope, team links and invitations are not alternate authorization sources. */
export function issueVisibilityPredicate(_userId: string, links: IssueVisibilityLinks, includeDeleted = false) {
  return and(
    includeDeleted ? undefined : sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`,
    eq(issues.ownershipState, 'bound'),
    links.workspaceIds?.length ? inArray(issues.workspaceId, [...links.workspaceIds]) : sql`false`,
  )!
}
