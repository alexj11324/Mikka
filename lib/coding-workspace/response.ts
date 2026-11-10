import 'server-only'
import type { Pool } from 'pg'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import type { ApiSession } from '../api-auth'
import { withWorkspaceAuthority, type WorkspaceAuthorizedActor } from './authority'
import type { WorkspaceActor } from './identity'
import { assertWorkspaceResultMaskPolicy, workspaceResultIdentity } from './requests'

/** The complete source was already verified. Hold the current authority while
 * refreshing its secret policy and synchronously constructing the response. */
export async function workspaceReadResponse(database: Pool, membership: Pool, request: Request, session: ApiSession,
  actor: WorkspaceActor, result: object, respond: () => Response): Promise<Response> {
  const identity = workspaceResultIdentity(result)
  if (!identity || identity.ownerId !== actor.userId || identity.workspaceId !== actor.workspaceId
    || session.user.id !== actor.userId || (session.tokenWorkspaceId && session.tokenWorkspaceId !== actor.workspaceId))
    throw new CodingWorkspaceError('workspace_not_found')
  const authorized: WorkspaceAuthorizedActor = { ...actor, credential: session.tokenWorkspaceId
    ? { kind: 'pat', id: session.session.id.slice(4) } : { kind: 'session', id: session.session.id } }
  return withWorkspaceAuthority(database, membership, authorized, identity.runId, async () => {
    await assertWorkspaceResultMaskPolicy(result, actor)
    request.signal.throwIfAborted()
    return respond()
  }, { live: identity, signal: request.signal })
}
