import { z } from 'zod'
import { applyRevert } from '@/lib/coding-workspace/git/revert'
import { gitEnvelope, gitHttp } from '@/lib/coding-workspace/git/http'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
const command = gitEnvelope.extend({ operationId: z.uuid() })

export const POST = gitHttp(async ({ actor, input, runId, repoId, request }) => {
  const value = command.parse(input)
  return { value: await applyRevert({ database: pool, membership: workspacePool }, actor, runId, repoId,
    { operationId: value.operationId }, request.signal) }
})
