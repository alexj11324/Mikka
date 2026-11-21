import { sql } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/core'
import { issues } from '@/lib/db/schema'

/**
 * Columns that stand in for `issues.content` where only its metadata or
 * checklist counts are used. A body is up to 250 KB; lists and polls that
 * read it for every row pay that in database egress.
 */

/** The body reduced to its attrs, where the metadata lives: readIssueMetadata reads it as it reads the full body. */
export const issueAttrsContent = sql<JSONContent>`jsonb_build_object('type', 'doc', 'attrs', ${issues.content}->'attrs')`

export type IssueLatestRun = { status: string; outcome: string | null; stopReason: string | null } | null
/**
 * Status only, read with an already authorized task row. The run must belong to
 * that task's tenant; the task visibility gate also gates this projection.
 * Keep it in the task SELECT so citations do not add another ACL/query round trip.
 * Qualify the outer row explicitly: Drizzle removes column qualifiers from
 * single-table SELECT expressions, which would bind bare id to the inner run.
 */
export const issueLatestRun = sql<[string, string | null, string | null] | null>`(select jsonb_build_array(status,outcome,"stopReason") from agent_runs where "issueId"=issues.id and "workspaceId"=issues."workspaceId" order by "createdAt" desc,id desc limit 1)`
  .mapWith((run): IssueLatestRun => run ? { status: run[0], outcome: run[1], stopReason: run[2] } : null)

/** issueChecklist's counts, computed in Postgres. Strict mode: lax `.**` visits array elements twice. */
export const issueChecklistTotal = sql<number>`jsonb_array_length(jsonb_path_query_array(${issues.content}, 'strict $.** ? (@.type == "taskItem")'))`.mapWith(Number)
export const issueChecklistChecked = sql<number>`jsonb_array_length(jsonb_path_query_array(${issues.content}, 'strict $.** ? (@.type == "taskItem" && @.attrs.checked == true)'))`.mapWith(Number)

export function checklistView(total: number, checked: number) {
  return { total, checked, percentage: total ? Math.round(checked / total * 100) : 0 }
}
