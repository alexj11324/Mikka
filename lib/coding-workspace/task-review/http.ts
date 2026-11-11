import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { auth } from '../../api-auth'
import { writeAllowed } from '../../mobile-api'
import { pool } from '../../db'
import { workspacePool } from '../../workspace-db'
import { loadWorkspaceContext, WorkspaceError } from '../../workspace-access'
import { maskDeep } from '../../secrets/mask'
import { workspaceJSON, workspaceErrorStatus, workspaceSessionStillValid } from '../http'
import { withReviewTransaction, type ReviewActor, type ReviewScope } from '../diff/authority'
import { reviewMasks } from '../diff/batch-store'
import { githubDiffProvider } from '../diff/github'
import type { DiffDependencies } from '../diff/service'
import { reviewTaskOwner, type TaskReviewContext } from './context'

export type TaskReviewHttpInput = { request: Request; actor: ReviewActor; deps: DiffDependencies; taskId: string; input: Record<string, unknown> }
export type TaskReviewHttpResult = { context: TaskReviewContext | null; status?: number;
  render: (tx: PoolClient, scope: ReviewScope) => Promise<{ body: unknown; status?: number; sourcePolicy?: string; maskPolicies?: string[] }> }
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const envelope = z.object({ workspaceId: z.uuid().optional() }).passthrough()
export class TaskReviewDenied extends Error {
  constructor(readonly reason: 'not_owner_send' | 'not_owner_merge' | 'github_permission', options?: ErrorOptions) { super(reason, options); this.name = 'TaskReviewDenied' }
}

/** Only public projections reach JSON. Remote reads happen before this final
 * lease; its callback rereads retained evidence under current Task, Workspace
 * and credential authority, then masks and serializes synchronously. */
export function taskReviewHttp(work: (input: TaskReviewHttpInput) => Promise<TaskReviewHttpResult>) {
  return async (request: Request, route: { params: Promise<{ taskId: string }> }) => {
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
    if (request.method !== 'GET' && !session.tokenWorkspaceId && !writeAllowed(request))
      return Response.json({ error: 'workspace_not_found' }, { status: 403, headers })
    try {
      const taskId = z.uuid().parse((await route.params).taskId), query = new URL(request.url).searchParams
      if (request.method === 'GET' && new Set(query.keys()).size !== [...query.keys()].length)
        throw new CodingWorkspaceError('workspace_invalid_request')
      const input = envelope.parse(request.method === 'GET' ? Object.fromEntries(query) : await workspaceJSON(request, 256 * 1024))
      const workspace = await loadWorkspaceContext(input.workspaceId, session.user)
      const actor: ReviewActor = { userId: session.user.id, workspaceId: workspace.workspace.id, credential: session.tokenWorkspaceId
        ? { kind: 'pat', id: z.uuid().parse(session.session.id.slice(4)) } : { kind: 'session', id: session.session.id } }
      const deps: DiffDependencies = { database: pool, membership: workspacePool, external: githubDiffProvider(pool, actor.userId, request.signal) }
      await reviewTaskOwner(pool, actor, taskId)
      const result = await work({ request, actor, deps, taskId, input })
      if (!await workspaceSessionStillValid(request, session)) return Response.json({ error: 'authRequired' }, { status: 401, headers })
      if (!result.context) {
        await reviewTaskOwner(pool, actor, taskId)
        return Response.json(null, { status: result.status ?? 200, headers })
      }
      const context = result.context
      return await withReviewTransaction(pool, workspacePool, actor, context.scope.identity.runId, context.scope.identity.repoId, async (tx, scope) => {
        if (scope.taskId !== taskId || !isDeepStrictEqual(scope.identity, context.scope.identity)
          || await reviewTaskOwner(tx, actor, taskId) !== context.ownerId) throw new CodingWorkspaceError('workspace_not_found')
        const rendered = await result.render(tx, scope), masks = await reviewMasks(actor, scope)
        if ((rendered.sourcePolicy && rendered.sourcePolicy !== masks[0]!.sourcePolicy)
          || (rendered.maskPolicies && (rendered.maskPolicies.length !== masks.length || rendered.maskPolicies.some((policy, index) => policy !== masks[index]!.sourcePolicy)))
          || masks.some(mask => !isDeepStrictEqual(maskDeep(rendered.body, mask), rendered.body))) throw new CodingWorkspaceError('workspace_path_unavailable')
        return Response.json(rendered.body, { status: rendered.status ?? result.status ?? 200, headers })
      }, { signal: request.signal })
    } catch (error) {
      if (error instanceof TaskReviewDenied) return Response.json({ error: error.reason, reason: error.reason }, { status: 403, headers })
      if (error instanceof z.ZodError) return Response.json({ error: 'workspace_invalid_request' }, { status: 400, headers })
      if (error instanceof WorkspaceError) return Response.json({ error: 'workspace_not_found' }, { status: 404, headers })
      if (error instanceof CodingWorkspaceError) return Response.json({ error: error.code }, { status: workspaceErrorStatus(error), headers })
      if (error instanceof WorkspaceReviewError) return Response.json({ error: error.code }, { headers,
        status: error.code === 'workspace_snapshot_unavailable' ? 404 : error.code === 'workspace_review_github_forbidden' ? 403
          : error.code === 'workspace_review_github_unavailable' ? 502 : 409 })
      throw error
    }
  }
}
