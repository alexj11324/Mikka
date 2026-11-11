import { listRunGitHistory } from '@/lib/coding-workspace/git/service'
import { gitHttp, gitPagination } from '@/lib/coding-workspace/git/http'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export const GET = gitHttp(async ({ actor, input, runId, repoId, request }) => {
  const query = gitPagination.parse(input)
  const result = await listRunGitHistory({ database: pool, membership: workspacePool }, actor, runId, repoId,
    { cursor: query.cursor, limit: query.limit ?? 30 }, request.signal)
  return { value: result.value, live: result.live }
})
