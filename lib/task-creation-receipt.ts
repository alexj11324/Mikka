import 'server-only'
import { sql } from 'drizzle-orm'
import type { db } from './db'
import { ActionFailureError } from './action-error'
import { issueForUser } from './issue-access'
import type { IssueReader } from './issue-visibility'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Both explicit intents share a command namespace. Retain a tombstone when
 * the Task is deleted and a caller retries an already accepted write. */
export async function withTaskCreationReceipt(tx: Transaction, reader: IssueReader, workspaceId: string,
  requestId: string, payload: unknown, create: () => Promise<{ taskId: string; identifier: string }>, reconcile?: (taskId: string) => Promise<void>) {
  const userId = typeof reader === 'string' ? reader : reader.id
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['task-create', userId, requestId])}, 0))`)
  const hashed = await tx.execute<{ fingerprint: string }>(
    sql`select encode(sha256(convert_to(${JSON.stringify(payload)}::jsonb::text, 'UTF8')), 'hex') as fingerprint`)
  const fingerprint = hashed.rows[0]!.fingerprint
  const previous = await tx.execute<{ workspaceId: string; fingerprint: string; taskId: string; identifier: string }>(
    sql`select "workspaceId", fingerprint, "taskId", identifier from task_creation_receipts
      where "userId"=${userId} and "requestId"=${requestId}`)
  const receipt = previous.rows[0]
  if (receipt) {
    if (receipt.workspaceId !== workspaceId || receipt.fingerprint !== fingerprint) throw new ActionFailureError('submissionConflict')
    const issue = await issueForUser(reader, receipt.taskId, false, tx, { withoutBody: true })
    if (!issue || issue.workspaceId !== workspaceId) throw new ActionFailureError('issueNotFound')
    if (reconcile) await reconcile(receipt.taskId)
    return { taskId: receipt.taskId, identifier: receipt.identifier }
  }
  const created = await create()
  await tx.execute(sql`insert into task_creation_receipts ("userId", "requestId", "workspaceId", fingerprint, "taskId", identifier)
    values (${userId}, ${requestId}, ${workspaceId}, ${fingerprint}, ${created.taskId}, ${created.identifier})`)
  return created
}
