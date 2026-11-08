import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { auth, type ApiSession } from '../api-auth'

/** A device round trip can outlive a session/PAT revocation. Reauthenticate
 * immediately before returning protected source or reference metadata. */
export async function workspaceSessionStillValid(request: Request, expected: ApiSession): Promise<boolean> {
  const current = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
  return Boolean(current && current.user.id === expected.user.id && current.session.id === expected.session.id &&
    current.tokenWorkspaceId === expected.tokenWorkspaceId)
}

export async function workspaceJSON(request: Request, limit = 16 * 1024): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new CodingWorkspaceError('workspace_invalid_request')
  const reader = request.body?.getReader()
  if (!reader) throw new CodingWorkspaceError('workspace_invalid_request')
  const parts: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) { await reader.cancel(); throw new CodingWorkspaceError('workspace_limit_exceeded') }
      parts.push(value)
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) }
    catch (cause) { throw new CodingWorkspaceError('workspace_invalid_request', { cause }) }
  } finally { reader.releaseLock() }
}

export function workspaceErrorStatus(error: CodingWorkspaceError): number {
  if (error.code === 'workspace_not_found' || error.code === 'workspace_path_unavailable') return 404
  if (error.code === 'workspace_invalid_request') return 400
  if (error.code === 'workspace_limit_exceeded') return 429
  if (error.code === 'workspace_unsupported') return 422
  return 409
}
