import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { diffSnapshot, taskReviewRef, WorkspaceReviewError, type TaskReviewRef } from '@mikka/protocol/coding-workspace-review'
import { issueForUser } from '../../issue-access'
import { tokenWorkspace } from '../../tokens/principal'
import { latestTaskRun } from '../../thread-dispatch'
import type { ReviewActor, ReviewScope } from '../diff/authority'
import { ensureReviewScope, type DiffDependencies } from '../diff/service'
import { readDiffSnapshot } from '../diff/store'

type Query = Pick<PoolClient, 'query'>
const denied = () => new CodingWorkspaceError('workspace_not_found')
export type TaskReviewContext = { taskId: string; ownerId: string; scope: ReviewScope }

/** Task visibility never chooses an execution identity. The persisted Task
 * owner selects their existing task thread; another viewer's thread, Bot's
 * current repository or editable assignee label cannot replace that source. */
export async function reviewTaskOwner(database: Query, actor: ReviewActor, taskId: string) {
  const task = await issueForUser({ id: actor.userId, [tokenWorkspace]: actor.workspaceId }, z.uuid().parse(taskId), false,
    drizzle(database as PoolClient), { withoutBody: true })
  if (!task) throw denied()
  return task.userId
}

export async function currentTaskReview(deps: DiffDependencies, actor: ReviewActor, taskId: string,
  signal?: AbortSignal): Promise<TaskReviewContext | null> {
  const ownerId = await reviewTaskOwner(deps.database, actor, taskId)
  const run = await latestTaskRun(deps.database, ownerId, taskId)
  if (!run) return null
  // A retained binding survives physical device/repo cleanup. Ambiguous
  // legacy bindings are not repaired by choosing the newest or first one.
  const { rows } = await deps.database.query<{ repoId: string }>(`SELECT "repoId" FROM coding_workspace_bindings
    WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3`, [run.id, ownerId, actor.workspaceId])
  if (rows.length > 1 || (rows[0] && run.deviceRepoId && rows[0].repoId !== run.deviceRepoId)) throw denied()
  const repoId = rows[0]?.repoId ?? run.deviceRepoId
  if (!repoId) return null
  const scope = await ensureReviewScope(deps, actor, run.id, repoId, signal)
  if (scope.taskId !== taskId || scope.identity.ownerId !== ownerId) throw denied()
  return { taskId, ownerId, scope }
}

/** An opaque snapshot id locates evidence, not authority. Recheck its Task,
 * immutable source identity and current viewer/Workspace access every time. */
export async function selectedTaskReview(deps: DiffDependencies, actor: ReviewActor, taskId: string,
  raw: TaskReviewRef, signal?: AbortSignal) {
  const reference = taskReviewRef.parse(raw), ownerId = await reviewTaskOwner(deps.database, actor, taskId)
  const { rows: [row] } = await deps.database.query<{ snapshot: unknown }>(`SELECT s.snapshot FROM coding_workspace_snapshots s
    JOIN coding_workspace_review_boards b ON b.id=s."boardId"
    WHERE s.id=$1 AND b."taskId"=$2 AND b."workspaceId"=$3`, [reference.snapshotId, taskId, actor.workspaceId])
  if (!row) throw denied()
  const selected = diffSnapshot.parse(row.snapshot)
  if (selected.taskId !== taskId || selected.identity.workspaceId !== actor.workspaceId || selected.identity.ownerId !== ownerId) throw denied()
  const { runId, repoId } = selected.identity
  const scope = await ensureReviewScope(deps, actor, runId, repoId, signal)
  const snapshot = await readDiffSnapshot(deps.database, scope, selected.id)
  if (snapshot.revision.version !== reference.sourceVersion) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  return { taskId, ownerId, scope, snapshot }
}

export async function assertCurrentTaskReview(database: Query, actor: ReviewActor, expected: TaskReviewContext) {
  if (await reviewTaskOwner(database, actor, expected.taskId) !== expected.ownerId
    || (await latestTaskRun(database, expected.ownerId, expected.taskId))?.id !== expected.scope.identity.runId)
    throw new WorkspaceReviewError('workspace_snapshot_outdated')
}
