import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from './db'
import { ActionFailureError } from './action-error'
import { requireUser, issueForUser } from './issue-access'
import { effectiveRequestWorkspace } from './request-workspace'
import { withTaskWorkspace } from './task-workspace'
import { openChatBotId } from './coordinator/coordinator-bot'
import { dispatchReceiptInput, type DispatchReceiptInput, type DispatchedTaskReceipt } from './task-create-command'

/** After Eve durably accepted the delivery, resolve the exact Task and original
 * user event without waiting for a model turn or listing the conversation. */
export async function readTaskDispatchReceipt(input: DispatchReceiptInput): Promise<DispatchedTaskReceipt | null> {
  const { workspaceId, requestId, botId: selectedBot } = dispatchReceiptInput.parse(input)
  const user = await requireUser()
  if (await effectiveRequestWorkspace(user) !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return withTaskWorkspace(user, workspaceId, async () => {
    const botId = await openChatBotId(user, selectedBot)
    const result = await db.execute<{ taskId: string; identifier: string; sourceEventId: string }>(
      sql`select c."taskId", c.identifier, e.id as "sourceEventId" from task_creation_receipts c
        join coordinator_events e on e."issueId"=c."taskId" and e."userId"=c."userId"
        join bots b on b.id=e."botId" and b."ownerId"=c."userId" and b."workspaceId"=c."workspaceId"
        where c."userId"=${user.id} and c."requestId"=${requestId} and c."workspaceId"=${workspaceId}
        and b.id=${botId} and e.kind='user_message' and e."deliveredAt" is not null
        and e.payload->>'taskCreationRequestId'=${requestId} and e.payload#>>'{taskCommand,intent}'='create_and_dispatch'`)
    const receipt = result.rows[0]
    if (!receipt) return null
    const issue = await issueForUser(user, receipt.taskId, false, db, { withoutBody: true })
    if (!issue || issue.workspaceId !== workspaceId) return null
    return { version: 1, taskId: receipt.taskId, identifier: receipt.identifier, dispatch: { sourceEventId: receipt.sourceEventId, botId } }
  })
}
