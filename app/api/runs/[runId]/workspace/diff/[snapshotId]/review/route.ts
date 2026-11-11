import { z } from 'zod'
import { reviewMutation } from '@mikka/protocol/coding-workspace-review'
import { reviewHttp } from '@/lib/coding-workspace/diff/http'
import { mutateReview, readReviewBoard } from '@/lib/coding-workspace/diff/review'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
const query = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), cursor: z.string().max(4096).optional() })
const command = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), mutation: reviewMutation })
export const GET = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input }) => {
  const value = query.parse(input)
  return readReviewBoard(deps, actor, runId, repoId, z.uuid().parse(snapshotId), value.cursor)
})
export const POST = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = command.parse(input)
  return mutateReview(deps, actor, runId, repoId, z.uuid().parse(snapshotId), value.mutation, request.signal)
})
