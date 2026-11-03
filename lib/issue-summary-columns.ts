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

/** issueChecklist's counts, computed in Postgres. Strict mode: lax `.**` visits array elements twice. */
export const issueChecklistTotal = sql<number>`jsonb_array_length(jsonb_path_query_array(${issues.content}, 'strict $.** ? (@.type == "taskItem")'))`.mapWith(Number)
export const issueChecklistChecked = sql<number>`jsonb_array_length(jsonb_path_query_array(${issues.content}, 'strict $.** ? (@.type == "taskItem" && @.attrs.checked == true)'))`.mapWith(Number)

export function checklistView(total: number, checked: number) {
  return { total, checked, percentage: total ? Math.round(checked / total * 100) : 0 }
}
