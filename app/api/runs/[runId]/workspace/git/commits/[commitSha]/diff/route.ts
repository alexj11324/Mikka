import { z } from 'zod'
import { reviewHttp } from '@/lib/coding-workspace/diff/http'
import { diffPage } from '@/lib/coding-workspace/diff/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const query = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), baseSha: sha, headSha: sha,
  cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).optional() })

/** Commit review reuses #1751's diff snapshot contract. `baseSha` is the
 * reviewed parent; no second Git reader is introduced. */
const handler = reviewHttp(async ({ deps, actor, runId, repoId, input, request }) => {
  const value = query.parse(input)
  return diffPage(deps, actor, runId, repoId,
    { selection: { source: 'commit', baseSha: value.baseSha, headSha: value.headSha }, cursor: value.cursor, limit: value.limit },
    request.signal)
})

export async function GET(request: Request, context: { params: Promise<{ runId: string; commitSha: string }> }) {
  const { runId, commitSha } = await context.params
  const url = new URL(request.url)
  url.searchParams.set('headSha', sha.parse(commitSha))
  return handler(new Request(url, { method: 'GET', headers: request.headers, signal: request.signal }),
    { params: Promise.resolve({ runId }) })
}
