import 'server-only'
import { db } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { activityActor } from '@/lib/activity-actor'
import { requireUser } from '@/lib/issue-access'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { withTaskCreationReceipt } from './task-creation-receipt'
import { createOnlyCommand, type CreateOnlyCommand } from './task-create-command'

/** Create a backlog Task without submitting a chat message, scheduling a Run or
 * starting a machine. Task identity and the durable receipt commit together. */
export async function createUnstartedTask(input: CreateOnlyCommand) {
  const parsed = createOnlyCommand.safeParse(input)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const { requestId, workspaceId, version, intent, ...fields } = parsed.data
  const user = await requireUser()
  if (await effectiveRequestWorkspace(user) !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return withTaskWorkspace(user, workspaceId, () => db.transaction(async tx => {
    const receipt = await withTaskCreationReceipt(tx, user, workspaceId, requestId, { version, intent, ...fields }, async () => {
      const issue = await createIssueForUserInTransaction(tx, user.id, fields, activityActor(user.id), { workspaceId, deriveShortTitle: false })
      if (!issue?.identifier) throw new ActionFailureError('issueCreateFailed')
      return { taskId: issue.id, identifier: issue.identifier }
    })
    return { version, ...receipt, dispatch: null }
  }))
}
