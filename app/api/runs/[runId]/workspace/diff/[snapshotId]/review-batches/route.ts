import { z } from 'zod'
import { reviewBatchRequest, WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { reviewHttp } from '@/lib/coding-workspace/diff/http'
import { deliverAgentReview } from '@/lib/coding-workspace/diff/agent-delivery'
import { readReviewDeliveries, reviewDeliveryQuery } from '@/lib/coding-workspace/diff/delivery'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
const query = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), batchId: z.uuid().optional(), cursor: z.string().max(1024).optional() })
const command = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), mutation: reviewBatchRequest })

export const GET = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = query.parse(input)
  return readReviewDeliveries(deps, actor, runId, repoId, z.uuid().parse(snapshotId),
    reviewDeliveryQuery.parse({ batchId: value.batchId, cursor: value.cursor }), request.signal)
})

export const POST = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = command.parse(input)
  if (value.mutation.snapshotId !== snapshotId) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  return { batch: await deliverAgentReview(deps, actor, runId, repoId, value.mutation, request.signal) }
})
