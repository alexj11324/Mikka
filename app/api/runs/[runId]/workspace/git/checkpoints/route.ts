import { listRunCheckpoints } from '@/lib/coding-workspace/git/service'
import { gitHttp } from '@/lib/coding-workspace/git/http'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export const GET = gitHttp(async ({ actor, runId, repoId, request }) => {
  return { value: await listRunCheckpoints({ database: pool, membership: workspacePool }, actor, runId, repoId, request.signal) }
})
