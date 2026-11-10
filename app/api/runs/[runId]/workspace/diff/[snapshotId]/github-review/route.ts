import { z } from 'zod'
import { githubReviewQuery, githubReviewMutation } from '@mikka/protocol/coding-workspace-review'
import { reviewHttp } from '@/lib/coding-workspace/diff/http'
import { readGitHubReview } from '@/lib/coding-workspace/diff/github-native'
import { deliverGitHubReview } from '@/lib/coding-workspace/diff/github-delivery'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
const query = githubReviewQuery.extend({ workspaceId: z.uuid().optional(), repoId: z.uuid() })
const command = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), mutation: githubReviewMutation })

export const GET = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = query.parse(input)
  return { review: await readGitHubReview(deps, actor, runId, repoId, z.uuid().parse(snapshotId),
    { cursor: value.cursor, threadId: value.threadId }, request.signal) }
}, { nativeReview: true })

export const POST = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = command.parse(input)
  return { batch: await deliverGitHubReview(deps, actor, runId, repoId, z.uuid().parse(snapshotId), value.mutation, request.signal) }
})
