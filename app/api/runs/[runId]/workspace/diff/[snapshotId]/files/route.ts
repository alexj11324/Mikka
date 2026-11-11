import { reviewHttp, reviewPageQuery } from '@/lib/coding-workspace/diff/http'
import { diffPage } from '@/lib/coding-workspace/diff/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
export const GET = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = reviewPageQuery.parse(input)
  return diffPage(deps, actor, runId, repoId, { snapshotId, cursor: value.cursor, limit: value.limit, unreviewed: value.unreviewed === 'true' }, request.signal)
})
