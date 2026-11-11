import 'server-only'
import { db } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { actingContext, activityActor } from '@/lib/activity-actor'
import { requireUser } from '@/lib/issue-access'
import { insertExplicitTask } from './task-create-scope'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { withTaskCreationReceipt } from './task-creation-receipt'
import { createOnlyCommand, type CreateOnlyCommand } from './task-create-command'

/** Create a backlog Task without submitting a chat message, scheduling a Run or
 * starting a machine. Task identity and the durable receipt commit together. */
export async function createUnstartedTask(input: CreateOnlyCommand) {
  const parsed = createOnlyCommand.safeParse(input)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const { requestId, workspaceId, version, intent, teamId, ...fields } = parsed.data
  if (teamId && actingContext.getStore()) throw new ActionFailureError('teamIssueAccessDenied')
  const user = await requireUser()
  if (await effectiveRequestWorkspace(user) !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return withTaskWorkspace(user, workspaceId, () => db.transaction(async tx => {
    const create = () => insertExplicitTask(tx, user.id, workspaceId, requestId, fields, activityActor(user.id), teamId)
    const receipt = await withTaskCreationReceipt(tx, user, workspaceId, requestId, { version, intent, ...(teamId ? { teamId } : {}), ...fields }, create,
      teamId ? async expected => { if ((await create()).taskId !== expected) throw new ActionFailureError('submissionConflict') } : undefined)
    return { version, ...receipt, dispatch: null }
  }))
}
