import { z } from 'zod'
import { CodingWorkspaceError, workspaceReadRequest } from '@mikka/protocol/coding-workspace'
import { auth } from '@/lib/api-auth'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { requestWorkspaceRead } from '@/lib/coding-workspace/requests'
import { workspaceReadResponse } from '@/lib/coding-workspace/response'
import { workspaceErrorStatus, workspaceSessionStillValid } from '@/lib/coding-workspace/http'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
  try {
    const runId = z.uuid().parse((await context.params).runId)
    const search = new URL(request.url).searchParams
    if ((search.has('source') && search.get('source') !== 'working') || search.has('ref'))
      throw new CodingWorkspaceError('workspace_unsupported')
    const repoId = z.uuid().parse(search.get('repoId'))
    const kind = search.get('kind') ?? 'tree'
    const input = workspaceReadRequest.parse(kind === 'search'
      ? { kind, query: search.get('query'), ...(search.has('limit') ? { limit: Number(search.get('limit')) } : {}) }
      : kind === 'file' ? { kind, path: search.get('path'), ...(search.has('headSha') || search.has('contentSha256')
        ? { expected: { headSha: search.get('headSha'), contentSha256: search.get('contentSha256') } } : {}), ...(search.has('startLine') || search.has('endLine')
        ? { range: { startLine: Number(search.get('startLine')), endLine: Number(search.get('endLine')) } } : {}) }
        : { kind, path: search.get('path') ?? '', ...(search.has('cursor') ? { cursor: search.get('cursor') } : {}), ...(search.has('limit') ? { limit: Number(search.get('limit')) } : {}) })
    const workspace = await loadWorkspaceContext(search.get('workspaceId') ?? undefined, session.user)
    const result = await requestWorkspaceRead(pool, workspacePool, { userId: session.user.id, workspaceId: workspace.workspace.id }, runId, repoId, input, request.signal)
    if (!await workspaceSessionStillValid(request, session)) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
    if (result.ok) return await workspaceReadResponse(pool, workspacePool, request, session,
      { userId: session.user.id, workspaceId: workspace.workspace.id }, result, () => Response.json(result, { headers }))
    return Response.json(result, { status: result.ok ? 200 : workspaceErrorStatus(new CodingWorkspaceError(result.code)), headers })
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ ok: false, code: 'workspace_invalid_request' }, { status: 400, headers })
    if (error instanceof WorkspaceError) return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 404, headers })
    if (error instanceof CodingWorkspaceError) return Response.json({ ok: false, code: error.code }, { status: workspaceErrorStatus(error), headers })
    throw error
  }
}
