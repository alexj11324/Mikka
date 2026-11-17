import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { projects, projectTasks } from '@/lib/db/projects'
import { lockResourceAccess } from '@/lib/resource-access/store'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { sendThreadMessage } from '@/lib/thread-continue'
import { ScheduleError } from './contract'

export async function continueStandingTask(ownerId: string, workspaceId: string, taskId: string, text: string, occurrenceId: string) {
  try {
    return await withTaskWorkspace(ownerId, workspaceId, async (_workspace, directory) => {
      const relation = async () => (await directory.select({ id: projectTasks.projectId, workspaceId: projectTasks.workspaceId })
        .from(projectTasks).where(eq(projectTasks.issueId, taskId)))[0]
      const before = await relation()
      if (before) {
        if (before.workspaceId !== workspaceId) throw new ScheduleError('scheduleStandingTaskUnavailable', 403)
        const [project] = await directory.select({ id: projects.id }).from(projects)
          .where(and(eq(projects.id, before.id), eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt))).for('share')
        if (!project) throw new ScheduleError('scheduleStandingTaskUnavailable', 403)
      }
      // The thread writer owns its original receipt and delivery transactions.
      // Keep a read lease through their commit without enlisting them in it.
      return db.transaction(async app => {
        const policy = await lockResourceAccess(app, ownerId, { kind: 'task', id: taskId, workspaceId }, 'canSteer')
        // A move can commit the APP parent and canonical Workspace relation
        // separately. Both must still describe the Project whose row is held.
        const current = await relation()
        if (before?.id !== current?.id || current && current.workspaceId !== workspaceId ||
            (policy.parentKind === 'project' ? policy.parentId : null) !== (current?.id ?? null)) {
          throw new ScheduleError('scheduleStandingTaskUnavailable', 403)
        }
        const { rows: [issue] } = await app.execute<{ title: string; status: string; identifier: string | null; runId: string | null }>(sql`
          SELECT i.title, i.status, r.identifier,
            (SELECT a.id FROM agent_runs a WHERE a."issueId"=i.id AND a."userId"=${ownerId} AND a."workspaceId"=i."workspaceId"
             ORDER BY a."createdAt" DESC, a.id DESC LIMIT 1) AS "runId"
          FROM issues i LEFT JOIN task_creation_receipts r ON r."taskId"=i.id AND r."userId"=${ownerId}
          WHERE i.id=${taskId} AND i."workspaceId"=${workspaceId} FOR KEY SHARE OF i`)
        if (!issue) throw new ScheduleError('scheduleStandingTaskUnavailable', 403)
        if (!issue.runId) throw new ScheduleError('scheduleStandingTaskNotStarted', 503)
        const sent = await sendThreadMessage(ownerId, issue.runId, text, 'user', occurrenceId)
        return { id: taskId, title: issue.title, status: issue.status, identifier: issue.identifier, runId: sent.runId, continued: true as const }
      })
    })
  } catch (error) {
    if (error instanceof ActionFailureError && ['workspaceAccessDenied', 'issueNotFound', 'runNotFound'].includes(error.code)) {
      throw new ScheduleError('scheduleStandingTaskUnavailable', 403, { cause: error })
    }
    throw error
  }
}
