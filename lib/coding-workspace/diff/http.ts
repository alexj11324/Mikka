import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { diffFilePatch, diffSnapshot, WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { auth, type ApiSession } from '../../api-auth'
import { loadWorkspaceContext, WorkspaceError } from '../../workspace-access'
import { pool } from '../../db'
import { workspacePool } from '../../workspace-db'
import { workspaceJSON, workspaceErrorStatus, workspaceSessionStillValid } from '../http'
import { withReviewTransaction, type ReviewActor } from './authority'
import type { DiffDependencies } from './service'
import { readDiffSnapshot, readStoredDiffFile } from './store'
import { secretMaskerFor } from '../../secrets/runtime'
import { maskDeep } from '../../secrets/mask'
import { githubDiffProvider } from './github'
import { nativeReviewPolicyMatches } from './github-native'

type Context = { params: Promise<{ runId: string; snapshotId?: string }> }
type Input = { request: Request; actor: ReviewActor; session: ApiSession; deps: DiffDependencies;
  runId: string; snapshotId?: string; repoId: string; input: Record<string, unknown> }
const responseHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const envelope = z.object({ workspaceId: z.uuid().optional(), repoId: z.uuid() }).passthrough()

export function reviewHttp(work: (input: Input) => Promise<unknown>, options: { sourceFile?: boolean; nativeReview?: boolean } = {}) {
  return async (request: Request, context: Context) => {
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (!session?.user) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers: responseHeaders })
    if (request.method !== 'GET' && !session.tokenWorkspaceId && request.headers.get('origin') !== new URL(request.url).origin)
      return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 403, headers: responseHeaders })
    try {
      const params = await context.params, runId = z.uuid().parse(params.runId)
      const snapshotId = params.snapshotId === undefined ? undefined : z.uuid().parse(params.snapshotId)
      const query = new URL(request.url).searchParams
      if (request.method === 'GET' && new Set(query.keys()).size !== [...query.keys()].length)
        throw new CodingWorkspaceError('workspace_invalid_request')
      const input = envelope.parse(request.method === 'GET' ? Object.fromEntries(query) : await workspaceJSON(request, 32 * 1024))
      const workspace = await loadWorkspaceContext(input.workspaceId, session.user)
      const actor: ReviewActor = { userId: session.user.id, workspaceId: workspace.workspace.id, credential: session.tokenWorkspaceId
        ? { kind: 'pat', id: z.uuid().parse(session.session.id.slice(4)) } : { kind: 'session', id: session.session.id } }
      const result = await work({ request, actor, session, deps: { database: pool, membership: workspacePool,
        external: githubDiffProvider(pool, actor.userId, request.signal) },
        runId, repoId: input.repoId, snapshotId, input })
      if (!await workspaceSessionStillValid(request, session)) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers: responseHeaders })
      // The provider/device wait has ended. Hold current authority through the
      // final mask observation and synchronous serialization of protected data.
      return await withReviewTransaction(pool, workspacePool, actor, runId, input.repoId, async (client, scope) => {
        let value = result as Record<string, unknown>
        const selected = snapshotId ? await readDiffSnapshot(client, scope, snapshotId)
          : value.snapshot ? diffSnapshot.parse(value.snapshot) : undefined
        if (selected && (!isDeepStrictEqual(selected.identity, scope.identity) || selected.taskId !== scope.taskId))
          throw new CodingWorkspaceError('workspace_not_found')
        let proofPolicy: string | undefined
        if (options.sourceFile) {
          const file = diffFilePatch.parse(value.file)
          if (!selected || file.snapshotId !== selected.id || file.sourceVersion !== selected.revision.version)
            throw new WorkspaceReviewError('workspace_snapshot_outdated')
          const proofMask = await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: scope.identity.ownerId })
          const stored = await readStoredDiffFile(client, scope, selected, file.file.path, proofMask)
          if (stored.file.fileVersion !== file.file.fileVersion) throw new WorkspaceReviewError('workspace_snapshot_outdated')
          proofPolicy = proofMask.sourcePolicy
          value = { file: stored.patch ?? { ...file, file: stored.file, format: 'unavailable', patch: null, hunks: [] } }
        }
        const masks = await Promise.all([
          secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: scope.identity.ownerId }),
          secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId }),
        ])
        if ((options.sourceFile && (!proofPolicy || proofPolicy !== masks[0]!.sourcePolicy))
          || (options.nativeReview && !nativeReviewPolicyMatches(value.review, masks))
          || masks.some(mask => !isDeepStrictEqual(maskDeep(value, mask), value)))
          throw new CodingWorkspaceError('workspace_path_unavailable')
        return Response.json({ ok: true, ...value }, { headers: responseHeaders })
      }, { signal: request.signal })
    } catch (error) {
      if (error instanceof z.ZodError) return Response.json({ ok: false, code: 'workspace_invalid_request' }, { status: 400, headers: responseHeaders })
      if (error instanceof WorkspaceError) return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 404, headers: responseHeaders })
      if (error instanceof CodingWorkspaceError) return Response.json({ ok: false, code: error.code }, { status: workspaceErrorStatus(error), headers: responseHeaders })
      if (error instanceof WorkspaceReviewError) {
        const status = error.code === 'workspace_snapshot_unavailable' ? 404 : error.code === 'workspace_review_github_forbidden' ? 403
          : error.code === 'workspace_review_github_unavailable' ? 502 : 409
        return Response.json({ ok: false, code: error.code }, { status, headers: responseHeaders })
      }
      throw error
    }
  }
}

export const reviewPageQuery = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(), unreviewed: z.enum(['true', 'false']).optional() })
