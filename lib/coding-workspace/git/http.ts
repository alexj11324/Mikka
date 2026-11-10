import 'server-only'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { CodingWorkspaceError, type RunWorktreeIdentity } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { WorkspaceGitError } from '@mikka/protocol/coding-workspace-git'
import { auth, type ApiSession } from '../../api-auth'
import { loadWorkspaceContext, WorkspaceError } from '../../workspace-access'
import { pool } from '../../db'
import { workspacePool } from '../../workspace-db'
import { maskDeep } from '../../secrets/mask'
import { secretMaskerFor } from '../../secrets/runtime'
import { workspaceErrorStatus, workspaceJSON, workspaceSessionStillValid } from '../http'
import { withReviewTransaction, type ReviewActor } from '../diff/authority'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
export const gitEnvelope = z.object({ workspaceId: z.uuid().optional(), repoId: z.uuid() }).passthrough()
export type GitInput = { request: Request; session: ApiSession; actor: ReviewActor; runId: string; repoId: string
  input: Record<string, unknown> }
export type GitResult = { value: object; live?: RunWorktreeIdentity | null }

/** Strip server-internal fields (the exact reverted bytes) before serializing. */
function publicValue(value: object) {
  if ('afterContentBase64' in value) {
    const { afterContentBase64: _internal, ...rest } = value as Record<string, unknown>
    return rest
  }
  return value
}

function gitStatus(error: WorkspaceGitError) {
  return error.code === 'workspace_git_revert_unsupported' || error.code === 'workspace_git_restore_unavailable' ? 422 : 409
}

export function gitHttp(work: (input: GitInput) => Promise<GitResult>) {
  return async (request: Request, context: { params: Promise<{ runId: string }> }) => {
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (!session?.user) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
    if (request.method !== 'GET' && !session.tokenWorkspaceId && request.headers.get('origin') !== new URL(request.url).origin)
      return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 403, headers })
    try {
      const runId = z.uuid().parse((await context.params).runId)
      const query = new URL(request.url).searchParams
      if (request.method === 'GET' && new Set(query.keys()).size !== [...query.keys()].length)
        throw new CodingWorkspaceError('workspace_invalid_request')
      const input = gitEnvelope.parse(request.method === 'GET' ? Object.fromEntries(query) : await workspaceJSON(request, 32 * 1024))
      const workspace = await loadWorkspaceContext(input.workspaceId, session.user)
      const actor: ReviewActor = { userId: session.user.id, workspaceId: workspace.workspace.id, credential: session.tokenWorkspaceId
        ? { kind: 'pat', id: z.uuid().parse(session.session.id.slice(4)) } : { kind: 'session', id: session.session.id } }
      const result = await work({ request, session, actor, runId, repoId: input.repoId, input })
      if (!await workspaceSessionStillValid(request, session)) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
      return await withReviewTransaction(pool, workspacePool, actor, runId, input.repoId, async (client, scope) => {
        const live = result.live ?? undefined
        if (live && (live.runId !== scope.identity.runId || live.repoId !== scope.identity.repoId
          || live.ownerId !== scope.identity.ownerId || live.workspaceId !== scope.identity.workspaceId
          || live.repositoryKey !== scope.identity.repositoryKey))
          throw new CodingWorkspaceError('workspace_not_found')
        const value = publicValue(result.value)
        const masks = await Promise.all([
          secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: scope.identity.ownerId }),
          secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId }),
        ])
        if (masks.some(mask => !isDeepStrictEqual(maskDeep(value, mask), value)))
          throw new CodingWorkspaceError('workspace_path_unavailable')
        return Response.json(value, { headers })
      }, live ? { live, signal: request.signal } : { historical: true, signal: request.signal })
    } catch (error) {
      if (error instanceof z.ZodError) return Response.json({ ok: false, code: 'workspace_invalid_request' }, { status: 400, headers })
      if (error instanceof WorkspaceError) return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 404, headers })
      if (error instanceof CodingWorkspaceError) return Response.json({ ok: false, code: error.code }, { status: workspaceErrorStatus(error), headers })
      if (error instanceof WorkspaceGitError) return Response.json({ ok: false, code: error.code }, { status: gitStatus(error), headers })
      if (error instanceof WorkspaceReviewError) {
        const status = error.code === 'workspace_snapshot_unavailable' ? 404 : error.code === 'workspace_review_github_forbidden' ? 403
          : error.code === 'workspace_review_github_unavailable' ? 502 : 409
        return Response.json({ ok: false, code: error.code }, { status, headers })
      }
      throw error
    }
  }
}

export const gitPagination = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(),
  cursor: z.string().max(256).optional(), limit: z.coerce.number().int().min(1).max(50).optional() })
