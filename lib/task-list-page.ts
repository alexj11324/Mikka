import { z } from 'zod'

export const TASK_LIST_PAGE_SIZE = 100
export const taskListCursor = z.strictObject({ id: z.uuid(), updatedAt: z.iso.datetime({ offset: true }) })
export const taskListPageInput = z.strictObject({ workspaceId: z.uuid(), after: taskListCursor.nullable(), dispatchedBy: z.uuid().optional(), projectId: z.uuid().optional() })
export type TaskListPageInput = z.input<typeof taskListPageInput>

export function nextTaskListCursor(rows: readonly { id: string; updatedAt: Date | string }[]) {
  const last = rows.at(-1)
  return rows.length === TASK_LIST_PAGE_SIZE && last ? { id: last.id, updatedAt: new Date(last.updatedAt).toISOString() } : null
}
