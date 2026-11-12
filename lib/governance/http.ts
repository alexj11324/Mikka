import 'server-only'
import { z } from 'zod'
import { desktopSameOriginRequest } from '@/lib/desktop-auth'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { WorkspaceError } from '@/lib/workspace-error'
import { MailboxError } from '@/lib/mailbox-error'
import { ActionFailureError } from '@/lib/action-error'
import { GovernanceError } from './errors'

export async function governanceSession(request: Request, workspaceId?: string) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session || (workspaceId ? !apiWorkspaceAllowed(session, workspaceId) : !!session.tokenWorkspaceId)) throw new GovernanceError('access_denied')
  return session
}

export async function governanceMutationSession(request: Request, workspaceId: string) {
  if (!desktopSameOriginRequest(request)) throw new GovernanceError('access_denied')
  const session = await governanceSession(request, workspaceId)
  if (!session.tokenId && request.headers.has('cookie') && !request.headers.has('origin'))
    throw new GovernanceError('access_denied')
  return session
}

export async function governanceJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > 16384) throw new GovernanceError('invalid_request')
  const text = await request.text()
  if (text.length > 16384) throw new GovernanceError('invalid_request')
  try { return JSON.parse(text) } catch (cause) { throw new GovernanceError('invalid_request', cause) }
}

export async function governanceResponse(work: () => Promise<Response | unknown>): Promise<Response> {
  try {
    const value = await work()
    return value instanceof Response ? value : Response.json(value, { headers: { 'cache-control': 'private, no-store' } })
  } catch (error) {
    const known = error instanceof GovernanceError ? error
      : error instanceof z.ZodError ? new GovernanceError('invalid_request', error)
        : error instanceof WorkspaceError || (error instanceof MailboxError && error.status === 403)
          || (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') ? new GovernanceError('access_denied', error) : null
    if (!known) {
      console.error('governance_request_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
      return Response.json({ error: { code: 'governance_denied' } }, { status: 500, headers: { 'cache-control': 'private, no-store' } })
    }
    const status = known.detail === 'access_denied' ? 403 : known.detail === 'not_found' ? 404 : known.detail === 'invalid_request' ? 400 : 409
    return Response.json({ error: { code: known.code, detail: known.detail } }, { status, headers: { 'cache-control': 'private, no-store' } })
  }
}
