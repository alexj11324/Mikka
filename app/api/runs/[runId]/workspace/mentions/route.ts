import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { auth } from '@/lib/api-auth'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { createFileMention, resolveFileMentions, mentionCommand } from '@/lib/coding-workspace/mentions'
import { submitFileMentions } from '@/lib/coding-workspace/submit'
import { workspaceReadResponse } from '@/lib/coding-workspace/response'
import { ActionFailureError } from '@/lib/action-error'
import { workspaceJSON, workspaceErrorStatus, workspaceSessionStillValid } from '@/lib/coding-workspace/http'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
  if (!session.tokenWorkspaceId && request.headers.get('origin') !== new URL(request.url).origin)
    return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 403, headers })
  try {
    const runId = z.uuid().parse((await context.params).runId)
    const input = mentionCommand.parse(await workspaceJSON(request))
    const workspace = await loadWorkspaceContext(input.workspaceId, session.user)
    const actor = { userId: session.user.id, workspaceId: workspace.workspace.id }
    if (input.action === 'create') {
      const mention = await createFileMention(pool, workspacePool, actor, runId, input.repoId, input.selection, request.signal)
      if (!await workspaceSessionStillValid(request, session)) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
      return await workspaceReadResponse(pool, workspacePool, request, session, actor, mention,
        () => Response.json({ ok: true, mention }, { status: 201, headers }))
    }
    if (input.action === 'submit' && session.tokenWorkspaceId) return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 403, headers })
    const resolved = await resolveFileMentions(pool, workspacePool, actor, runId, input.repoId, input.ids, request.signal)
    if (!await workspaceSessionStillValid(request, session)) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
    if (input.action === 'resolve') {
      return await workspaceReadResponse(pool, workspacePool, request, session, actor, resolved, () => Response.json(resolved, { headers }))
    }
    const result = await submitFileMentions(pool, workspacePool, { ...actor, sessionId: session.session.id },
      { runId, repoId: input.repoId, text: input.text, requestId: input.requestId }, resolved, request.signal)
    return Response.json({ ok: true, ...result }, { headers })
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ ok: false, code: 'workspace_invalid_request' }, { status: 400, headers })
    if (error instanceof WorkspaceError) return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 404, headers })
    if (error instanceof CodingWorkspaceError) return Response.json({ ok: false, code: error.code }, { status: workspaceErrorStatus(error), headers })
    if (error instanceof ActionFailureError) return Response.json({ ok: false, code: error.code }, { status: 409, headers })
    throw error
  }
}
