import { z } from 'zod'
import { workspacePath } from '@mikka/protocol/coding-workspace'
import { reviewHttp } from '@/lib/coding-workspace/diff/http'
import { diffFile } from '@/lib/coding-workspace/diff/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
const query = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), path: workspacePath })
export const GET = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = query.parse(input)
  return { file: await diffFile(deps, actor, runId, repoId, z.uuid().parse(snapshotId), value.path, request.signal) }
}, { sourceFile: true })
