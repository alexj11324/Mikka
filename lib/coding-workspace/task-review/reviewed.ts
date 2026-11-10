import 'server-only'
import { z } from 'zod'
import { reviewedFileChange, taskReviewRef, WORKSPACE_DIFF_MAX_PAGE } from '@mikka/protocol/coding-workspace-review'
import { factoryEventId } from '../../factory/event-id'
import { mutateReview } from '../diff/review'
import { selectedTaskReview } from './context'
import type { TaskReviewHttpInput, TaskReviewHttpResult } from './http'

const request = z.strictObject({ workspaceId: z.uuid().optional(), reviewRef: taskReviewRef,
  idempotencyKey: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(),
  files: z.array(reviewedFileChange).min(1).max(WORKSPACE_DIFF_MAX_PAGE) })

/** Per-viewer local marks reuse the existing revision and audit ledger. */
export async function markTaskReviewFiles(input: TaskReviewHttpInput): Promise<TaskReviewHttpResult> {
  const value = request.parse(input.input), { deps, actor, taskId } = input
  const context = await selectedTaskReview(deps, actor, taskId, value.reviewRef, input.request.signal)
  const receipt = await mutateReview(deps, actor, context.scope.identity.runId, context.scope.identity.repoId, value.reviewRef.snapshotId,
    { action: 'reviewed', requestId: factoryEventId('workspace-task-reviewed', JSON.stringify([taskId, actor.userId, value.idempotencyKey])),
      expectedRevision: value.expectedRevision, files: value.files }, input.request.signal)
  return { context, render: async () => ({ body: { reviewRef: value.reviewRef, ...receipt } }) }
}
