import { z } from 'zod'

export const TASK_LIST_PAGE_SIZE = 100
export const taskListCursor = z.strictObject({ id: z.uuid(), updatedAt: z.iso.datetime({ offset: true }) })

/** The reader's views, as Capy's task list tabs. `forYou`: open tasks assigned to, mentioning or followed by the reader. */
export const TASK_LIST_VIEWS = ['forYou', 'assigned', 'created', 'mentioned', 'all'] as const
export type TaskListView = (typeof TASK_LIST_VIEWS)[number]
export const TASK_RELATION_FILTERS = ['blocked', 'related', 'duplicate', 'parent', 'child'] as const

const person = z.union([z.literal('me'), z.string().min(1).max(128)])
/**
 * Server-side filters, applied before the page LIMIT so older matching tasks are found (lib/task-list-page.ts users:
 * app/actions/issues.ts listWorkspaceTaskPage, app/api/mobile/tasks). `match` joins the property filters (assignee,
 * creator, labels, due, hasPr, relation, subscribed); `view` and `hideClosedChildren` always narrow.
 */
export const taskListFilters = {
  view: z.enum(TASK_LIST_VIEWS).optional(),
  assignee: z.array(person).min(1).max(20).optional(),
  creator: z.array(person).min(1).max(20).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).min(1).max(12).optional(),
  dueBefore: z.iso.date().optional(),
  dueAfter: z.iso.date().optional(),
  hasPr: z.boolean().optional(),
  relation: z.enum(TASK_RELATION_FILTERS).optional(),
  subscribed: z.boolean().optional(),
  hideClosedChildren: z.boolean().optional(),
  match: z.enum(['all', 'any']).optional(),
}
export const taskListPageInput = z.strictObject({ workspaceId: z.uuid(), after: taskListCursor.nullable(), dispatchedBy: z.uuid().optional(), projectId: z.uuid().optional(), teamId: z.uuid().optional(), parentId: z.uuid().optional(), ...taskListFilters })
export type TaskListPageInput = z.input<typeof taskListPageInput>
export type TaskListFilters = Pick<z.output<typeof taskListPageInput>, keyof typeof taskListFilters>

export function nextTaskListCursor(rows: readonly { id: string; updatedAt: Date | string }[]) {
  const last = rows.at(-1)
  return rows.length === TASK_LIST_PAGE_SIZE && last ? { id: last.id, updatedAt: new Date(last.updatedAt).toISOString() } : null
}
