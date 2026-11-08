import { z } from 'zod'
import { diffSelection } from '@mikka/protocol/coding-workspace-review'
import { reviewHttp, reviewPageQuery } from '@/lib/coding-workspace/diff/http'
import { diffPage } from '@/lib/coding-workspace/diff/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
const query = reviewPageQuery.extend({ source: z.string().optional(), baseSha: z.string().optional(), headSha: z.string().optional() })
export const GET = reviewHttp(async ({ deps, actor, runId, repoId, input, request }) => {
  const value = query.parse(input)
  const selection = diffSelection.parse({ source: value.source ?? 'auto',
    ...(value.baseSha ? { baseSha: value.baseSha } : {}), ...(value.headSha ? { headSha: value.headSha } : {}) })
  return diffPage(deps, actor, runId, repoId, { selection, cursor: value.cursor, limit: value.limit, unreviewed: value.unreviewed === 'true' }, request.signal)
})
