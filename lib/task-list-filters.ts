import { and, not, or, sql, type SQL } from 'drizzle-orm'
import { issues } from '@/lib/db/schema'
import type { TaskListFilters } from './task-list-page'

/** A task's Mikka metadata (lib/issue-metadata.ts), as the GIN index `issues_metadata_gin_idx` covers it. */
export const issueMetadataSql = sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')`
const CLOSED = sql`array['done','canceled','duplicate']::text[]`

const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`
/** Containment on the metadata, so the GIN index (jsonb_path_ops) answers it. */
const has = (value: Record<string, unknown>) => sql`${issueMetadataSql} @> ${json(value)}`
const anyOf = (parts: SQL[]) => parts.length === 1 ? parts[0] : or(...parts)!

const assignedTo = (ids: readonly string[]) => anyOf(ids.map(id => has({ assignee: { id } })))
const mentions = (userId: string) => sql`jsonb_path_exists(${issues.content}, '$.** ? (@.type == "mention" && @.attrs.id == $u)', jsonb_build_object('u', ${userId}::text))`
const follows = (userId: string) => has({ subscriberUserIds: [userId] })

/**
 * The list filters as one predicate on `issues`, applied before LIMIT and to the cursor's anchor, so a page never
 * misses an older matching task. `me` is the reader. Returns undefined when nothing narrows the list.
 */
export function taskListFilterPredicate(filters: TaskListFilters, userId: string): SQL | undefined {
  const people = (values: readonly string[]) => [...new Set(values.map(value => value === 'me' ? userId : value))]
  const properties: SQL[] = []
  if (filters.assignee) properties.push(assignedTo(people(filters.assignee)))
  if (filters.creator) properties.push(sql`${issues.userId} = any(${sql.param(people(filters.creator))}::text[])`)
  if (filters.labels) properties.push(anyOf(filters.labels.map(name => has({ labels: [{ name }] }))))
  if (filters.dueBefore || filters.dueAfter) properties.push(and(
    sql`(${issueMetadataSql}->>'dueDate') is not null`,
    filters.dueBefore ? sql`(${issueMetadataSql}->>'dueDate') <= ${filters.dueBefore}` : undefined,
    filters.dueAfter ? sql`(${issueMetadataSql}->>'dueDate') >= ${filters.dueAfter}` : undefined,
  )!)
  if (filters.hasPr !== undefined) {
    const withPr = sql`jsonb_array_length(coalesce(${issueMetadataSql}->'pullRequests', '[]'::jsonb)) > 0`
    properties.push(filters.hasPr ? withPr : not(withPr))
  }
  if (filters.relation) properties.push({
    blocked: sql`jsonb_array_length(coalesce(${issueMetadataSql}->'blockedByIds', '[]'::jsonb)) > 0`,
    related: sql`jsonb_array_length(coalesce(${issueMetadataSql}->'relatedIds', '[]'::jsonb)) > 0`,
    duplicate: sql`(${issueMetadataSql}->>'duplicateOfId') is not null`,
    child: sql`(${issueMetadataSql}->>'parentId') is not null`,
    // A parent in the same tree: the child's owner is the parent's (app/actions/issues.ts inParent).
    parent: sql`exists (select 1 from issues c where c."workspaceId" = ${issues.workspaceId} and c."userId" = ${issues.userId}
      and coalesce(c.content->'attrs'->'mikka', c.content->'attrs'->'orvilo')->>'parentId' = ${issues.id}::text
      and coalesce(c.content->'attrs'->'mikka', c.content->'attrs'->'orvilo')->>'deletedAt' is null)`,
  }[filters.relation])
  if (filters.subscribed !== undefined) properties.push(filters.subscribed ? follows(userId) : not(follows(userId)))

  const narrow: (SQL | undefined)[] = [properties.length ? (filters.match === 'any' ? anyOf(properties) : and(...properties)) : undefined]
  switch (filters.view) {
    case 'assigned': narrow.push(assignedTo([userId])); break
    case 'created': narrow.push(sql`${issues.userId} = ${userId}`); break
    case 'mentioned': narrow.push(mentions(userId)); break
    case 'forYou': narrow.push(and(sql`not (${issues.status} = any(${CLOSED}))`, or(assignedTo([userId]), mentions(userId), follows(userId)))); break
  }
  if (filters.hideClosedChildren) narrow.push(sql`not ((${issueMetadataSql}->>'parentId') is not null and ${issues.status} = any(${CLOSED}))`)
  const present = narrow.filter((part): part is SQL => part !== undefined)
  return present.length ? and(...present) : undefined
}
