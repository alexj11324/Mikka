'use server'

import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { issues, taskReads } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/action-result'
import { requireIssueAccess, requireUser } from '@/lib/issue-access'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { ActionFailureError, runAction } from '@/lib/action-error'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { withIssueWorkspace } from '@/lib/issue-scope-authorization'
import { issueMetadataSql, taskListFilterPredicate } from '@/lib/task-list-filters'
import { TASK_LIST_VIEWS, type TaskListView } from '@/lib/task-list-page'

const live = sql`(${issueMetadataSql}->>'deletedAt') is null`

/** The task list's tabs (S1-C): how many visible tasks each view holds, across the whole authorized collection. */
export async function countTaskListViews(workspaceId: string): Promise<Record<TaskListView, number>> {
  z.uuid().parse(workspaceId)
  const user = await requireUser()
  if (await effectiveRequestWorkspace(user) !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return withTaskWorkspace(user, workspaceId, async () => {
    const count = (view: TaskListView) => {
      const predicate = taskListFilterPredicate({ view }, user.id)
      return predicate ? sql<number>`count(*) filter (where ${predicate})::int` : sql<number>`count(*)::int`
    }
    const [row] = await db.select(Object.fromEntries(TASK_LIST_VIEWS.map(view => [view, count(view)])) as Record<TaskListView, ReturnType<typeof count>>)
      .from(issues).where(and(issueVisibilityPredicate(user.id, { allowedIds: [], workspaceIds: [workspaceId] }), live))
    return row
  })
}

/** The tasks this person marked unread in the workspace, among those they can still see. */
export async function listUnreadTaskIds(workspaceId: string): Promise<string[]> {
  z.uuid().parse(workspaceId)
  const user = await requireUser()
  if (await effectiveRequestWorkspace(user) !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return withTaskWorkspace(user, workspaceId, async () => {
    const rows = await db.select({ id: issues.id }).from(taskReads)
      .innerJoin(issues, eq(issues.id, taskReads.issueId))
      .where(and(eq(taskReads.userId, user.id), eq(taskReads.workspaceId, workspaceId), eq(taskReads.unread, true),
        issueVisibilityPredicate(user.id, { allowedIds: [], workspaceIds: [workspaceId] }), live))
    return rows.map(row => row.id)
  })
}

/** Mark as unread / read for this person only. Opening a task marks it read. */
export async function setTaskUnread(input: { id: string; unread: boolean }): Promise<ActionResult<{ unread: boolean }>> {
  return runAction(async () => {
    const parsed = z.strictObject({ id: z.uuid(), unread: z.boolean() }).safeParse(input)
    if (!parsed.success) return { error: 'issueOperationInvalid' }
    const { issue, user } = await requireIssueAccess(parsed.data.id)
    if (!issue.workspaceId) return { error: 'issueUnavailable' }
    const workspaceId = issue.workspaceId
    return withIssueWorkspace(user, workspaceId, { issueId: issue.id, action: 'canReadContent' }, async () => {
      if (parsed.data.unread) {
        await db.insert(taskReads).values({ userId: user.id, issueId: issue.id, workspaceId, unread: true })
          .onConflictDoUpdate({ target: [taskReads.userId, taskReads.issueId], set: { unread: true, updatedAt: new Date() } })
      } else {
        // Reading a task that was never flagged writes nothing.
        await db.update(taskReads).set({ unread: false, updatedAt: new Date() })
          .where(and(eq(taskReads.userId, user.id), eq(taskReads.issueId, issue.id), eq(taskReads.unread, true)))
      }
      return { unread: parsed.data.unread }
    })
  })
}
