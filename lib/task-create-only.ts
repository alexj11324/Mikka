import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { activityActor } from '@/lib/activity-actor'
import { issueForUser, requireUser } from '@/lib/issue-access'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { createOnlyCommand, type CreateOnlyCommand } from './task-create-command'

/** Create a backlog Task without submitting a chat message, scheduling a Run or
 * starting a machine. Task identity and the durable receipt commit together. */
export async function createUnstartedTask(input: CreateOnlyCommand) {
  const parsed = createOnlyCommand.safeParse(input)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const { requestId, workspaceId, version, intent, ...fields } = parsed.data
  const user = await requireUser()
  if (await effectiveRequestWorkspace(user) !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  // jsonb produces the same fingerprint when a transport reorders document
  // object keys. No document, title or session token is stored in the receipt.
  const payload = JSON.stringify({ version, intent, ...fields })
  return withTaskWorkspace(user, workspaceId, () => db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['task-create', user.id, requestId])}, 0))`)
    const hashed = await tx.execute<{ fingerprint: string }>(sql`select encode(sha256(convert_to(${payload}::jsonb::text,'UTF8')), 'hex') as fingerprint`)
    const fingerprint = hashed.rows[0]!.fingerprint
    const previous = await tx.execute<{ workspaceId: string; fingerprint: string; taskId: string; identifier: string }>(
      sql`select "workspaceId", fingerprint, "taskId", identifier from task_creation_receipts
        where "userId"=${user.id} and "requestId"=${requestId}`)
    const receipt = previous.rows[0]
    if (receipt && (receipt.workspaceId !== workspaceId || receipt.fingerprint !== fingerprint)) throw new ActionFailureError('submissionConflict')
    if (receipt) {
      if (!await issueForUser(user, receipt.taskId, false, tx, { withoutBody: true })) throw new ActionFailureError('issueNotFound')
      return { version, taskId: receipt.taskId, identifier: receipt.identifier, dispatch: null }
    }
    const issue = await createIssueForUserInTransaction(tx, user.id, fields, activityActor(user.id), { workspaceId, deriveShortTitle: false })
    if (!issue?.identifier) throw new ActionFailureError('issueCreateFailed')
    await tx.execute(sql`insert into task_creation_receipts ("userId", "requestId", "workspaceId", fingerprint, "taskId", identifier)
      values (${user.id}, ${requestId}, ${workspaceId}, ${fingerprint}, ${issue.id}, ${issue.identifier})`)
    return { version, taskId: issue.id, identifier: issue.identifier, dispatch: null }
  }))
}
