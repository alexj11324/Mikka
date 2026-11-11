import 'server-only'
import { db } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { actingContext, activityActor } from '@/lib/activity-actor'
import { requireUser } from '@/lib/issue-access'
import { attachInitialProject, insertExplicitTask, reconcileInitialProject } from './task-create-scope'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { withTaskCreationReceipt } from './task-creation-receipt'
import { createOnlyCommand, type CreateOnlyCommand } from './task-create-command'

/** Create a backlog Task without submitting a chat message, scheduling a Run or
 * starting a machine. Task identity and the durable receipt commit together. */
export async function createUnstartedTask(input: CreateOnlyCommand) {
  const parsed = createOnlyCommand.safeParse(input)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const { requestId, workspaceId, version, intent, teamId, projectId, confirmAccess = false, ...fields } = parsed.data
  if ((teamId || projectId) && actingContext.getStore()) throw new ActionFailureError('teamIssueAccessDenied')
  const user = await requireUser()
  if (await effectiveRequestWorkspace(user) !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return withTaskWorkspace(user, workspaceId, () => db.transaction(async tx => {
    const actor = activityActor(user.id)
    const insert = () => insertExplicitTask(tx, user.id, workspaceId, requestId, fields, actor, teamId)
    const receipt = await withTaskCreationReceipt(tx, user, workspaceId, requestId,
      { version, intent, ...(teamId ? { teamId } : {}), ...(projectId ? { projectId } : {}), ...fields }, async () => {
        const created = await insert()
        if (projectId) await attachInitialProject(tx, user.id, workspaceId, created.taskId, projectId, actor, confirmAccess)
        return created
      }, teamId || projectId ? async expected => {
        if (teamId && (await insert()).taskId !== expected) throw new ActionFailureError('submissionConflict')
        if (projectId) await reconcileInitialProject(tx, user.id, workspaceId, expected, projectId, actor, confirmAccess)
      } : undefined)
    return { version, ...receipt, dispatch: null }
  }))
}
