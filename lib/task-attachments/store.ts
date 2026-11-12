import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { artifactStorage, getArtifactObjectStream, putArtifactObject } from '@/lib/artifacts/storage'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { armDueTimerAfterCommit } from '@/lib/due-timer'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { withIssueWorkspace } from '@/lib/issue-scope-authorization'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import type { IssueReader } from '@/lib/issue-visibility'
import { resourceActionAllowed } from '@/lib/resource-access/store'
import { TASK_FILE_MAX_COUNT, type TaskFile, type TaskFileList } from './contract'

type Actor = { user: Exclude<IssueReader, string>; workspaceId: string; taskId: string }
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export class TaskFileError extends Error {
  constructor(readonly code: 'tooMany' | 'conflict' | 'notFound') { super(code) }
}

/** Always acquire the membership and resource ACL leases before the task lock.
 * The task lock serializes the count/replay checks and fences soft deletion. */
function withFiles<T>(actor: Actor, write: boolean, work: (tx: Transaction, ownerId: string) => Promise<T>) {
  const { user, taskId, workspaceId } = actor
  return withIssueWorkspace(user, workspaceId, { issueId: taskId, action: write ? 'canSteer' : 'canReadContent' }, async (_, tx) => {
    // An explicit steer-only grant does not open the task detail or its files.
    if (write && !await resourceActionAllowed(tx, user.id, { kind: 'task', id: taskId, workspaceId }, 'canReadContent'))
      throw new ActionFailureError('issueNotFound')
    const [task] = await tx.select({ userId: issues.userId, workspaceId: issues.workspaceId, state: issues.ownershipState, content: issueAttrsContent })
      .from(issues).where(eq(issues.id, taskId)).for(write ? 'update' : 'share')
    if (!task || task.workspaceId !== workspaceId || task.state !== 'bound' || readIssueMetadata(task.content).deletedAt)
      throw new ActionFailureError('issueNotFound')
    return work(tx, task.userId)
  })
}

export function listTaskFiles(actor: Actor): Promise<TaskFileList> {
  return withFiles(actor, false, async tx => {
    const { rows } = await tx.execute<TaskFile>(sql`SELECT id,name,size FROM task_attachments WHERE "taskId"=${actor.taskId} ORDER BY "createdAt",id`)
    const canEdit = await resourceActionAllowed(tx, actor.user.id, { kind: 'task', id: actor.taskId, workspaceId: actor.workspaceId }, 'canSteer')
    return { files: rows, canEdit }
  })
}

export function readTaskFile(actor: Actor, id: string, signal: AbortSignal) {
  return withFiles(actor, false, async tx => {
    const { rows: [file] } = await tx.execute<{ name: string; size: number; storageKey: string | null; inlineData: Buffer | null }>(
      sql`SELECT name,size,"storageKey","inlineData" FROM task_attachments WHERE "taskId"=${actor.taskId} AND id=${id}`)
    if (!file) throw new TaskFileError('notFound')
    const body = file.storageKey ? await getArtifactObjectStream(file.storageKey, signal) : new Uint8Array(file.inlineData!)
    return { name: file.name, size: file.size, body }
  })
}

export async function saveTaskFile(actor: Actor, file: TaskFile, bytes: Uint8Array<ArrayBuffer>) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const checkCapacity = async (tx: Transaction) => {
    const { rows: [prior] } = await tx.execute<{ name: string; sha256: string }>(
      sql`SELECT name,sha256 FROM task_attachments WHERE "taskId"=${actor.taskId} AND id=${file.id}`)
    if (prior) {
      if (prior.sha256 !== digest || prior.name !== file.name) throw new TaskFileError('conflict')
      return 'replay'
    }
    const { rows: [count] } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM task_attachments WHERE "taskId"=${actor.taskId}`)
    if (count!.n >= TASK_FILE_MAX_COUNT) throw new TaskFileError('tooMany')
    return 'available'
  }
  const key = artifactStorage() === 'r2' ? `task-files/${actor.taskId}/${randomUUID()}` : null
  // Register a distinct object per attempt before its PUT. If authorization is
  // revoked, the process exits, or the final transaction rolls back, the normal
  // retirement worker collects the object. A replay cannot retire a winner.
  if (key) {
    const replay = await withFiles(actor, true, async tx => {
      if (await checkCapacity(tx) === 'replay') return true
      await tx.execute(sql`INSERT INTO chat_attachment_retirements("storageKey","taskId","notBefore") VALUES(${key},${actor.taskId},now()+interval '1 day')`)
      armDueTimerAfterCommit(tx, 'account-deletions')
      return false
    })
    if (replay) return file
  }
  return withFiles(actor, true, async (tx, ownerId) => {
    await tx.execute(sql`SELECT mikka_account_assert_writable(${actor.user.id})`)
    if (await checkCapacity(tx) === 'replay') {
      if (key) await tx.execute(sql`DELETE FROM chat_attachment_retirements WHERE "storageKey"=${key}`)
      return file
    }
    if (key) {
      await putArtifactObject(key, bytes, 'application/octet-stream')
      await tx.execute(sql`DELETE FROM chat_attachment_retirements WHERE "storageKey"=${key}`)
    }
    await tx.execute(sql`INSERT INTO task_attachments("taskId",id,name,size,sha256,"storageKey","inlineData","userId")
      VALUES(${actor.taskId},${file.id},${file.name},${file.size},${digest},${key},${key ? null : Buffer.from(bytes)},${ownerId})`)
    return file
  })
}

export function removeTaskFile(actor: Actor, id: string) {
  return withFiles(actor, true, async tx => {
    const removed = await tx.execute(sql`DELETE FROM task_attachments WHERE "taskId"=${actor.taskId} AND id=${id}`)
    if (!removed.rowCount) throw new TaskFileError('notFound')
    armDueTimerAfterCommit(tx, 'account-deletions')
  })
}
