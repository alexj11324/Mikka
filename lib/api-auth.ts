import 'server-only'
import { auth as sessionAuth } from '@/lib/auth'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { audienceAllows, type ApiAudience, type TokenScope } from '@/lib/tokens/format'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'

type BrowserSession = NonNullable<Awaited<ReturnType<typeof sessionAuth.api.getSession>>>
export type ApiSession = {
  user: Pick<BrowserSession['user'], 'id' | 'name' | 'email' | 'image'> & { [tokenWorkspace]?: string; [enterprisePrincipal]?: EnterprisePrincipal }
  session: { id: string }
  tokenWorkspaceId?: string
  /** Present only for a PAT session; absent for a browser cookie session. */
  tokenId?: string
  tokenScopes?: readonly TokenScope[]
}

/** PATs authenticate only the owner's ordinary API identity. They do not mint
 * cookies or a browser session, nor bypass a route's existing authorization.
 * `audience` defaults to the pre-M4 routes. `/api/v1` passes `'v1'`, which
 * rejects legacy-only tokens and every cookie session. */
export async function getApiSession(options: { headers: Headers; query?: { disableCookieCache?: boolean; disableRefresh?: boolean }; audience?: ApiAudience }): Promise<ApiSession | null> {
  const authorization = options.headers.get('authorization')
  const audience = options.audience ?? 'legacy'
  // An explicitly supplied PAT wins over a cookie, including when invalid.
  if (!/^Bearer\s+mkp_/i.test(authorization ?? '')) {
    // `/api/v1` is PAT-only: a browser cookie must never authenticate it.
    if (audience === 'v1') return null
    const session = await sessionAuth.api.getSession({ headers: options.headers, query: options.query })
    if (session) Object.defineProperty(session.user, enterprisePrincipal, { value: { kind: 'session', sessionId: session.session.id }, configurable: true })
    return session
  }
  const token = /^Bearer (mkp_[A-Za-z0-9_-]{43})$/i.exec(authorization!)?.[1]
  if (!token) return null
  const { verifyPersonalAccessToken } = await import('@/lib/tokens/store')
  const principal = await verifyPersonalAccessToken(token)
  // The token is real before the audience check, so a wrong-audience request
  // may still bump lastUsedAt. That is harmless and keeps one store call.
  if (!principal || !audienceAllows(principal.scopes, audience)) return null
  const [{ workspaceDb }, { requireWorkspace, WorkspaceError }, { db }, { users }, { eq }] = await Promise.all([
    import('@/lib/workspace-db'), import('@/lib/workspace-access'), import('@/lib/db'), import('@/lib/db/schema'), import('drizzle-orm'),
  ])
  const enterprise: EnterprisePrincipal = { kind: 'pat', tokenId: principal.tokenId, workspaceId: principal.workspaceId }
  try { await workspaceDb.transaction(tx => requireWorkspace(tx, principal.workspaceId, principal.userId, false, enterprise)) }
  catch (error) { if (error instanceof WorkspaceError) return null; throw error }
  const [user] = await db.select().from(users).where(eq(users.id, principal.userId)).limit(1)
  if (!user) return null
  // The scope accompanies the authenticated user into the existing workspace
  // resolver, without appearing in serialized user responses.
  Object.defineProperty(user, tokenWorkspace, { value: principal.workspaceId })
  Object.defineProperty(user, enterprisePrincipal, { value: enterprise })
  return { user, session: { id: `pat:${principal.tokenId}` }, tokenWorkspaceId: principal.workspaceId, tokenId: principal.tokenId, tokenScopes: principal.scopes }
}

export function apiWorkspaceAllowed(session: ApiSession, workspaceId: string) {
  return !session.tokenWorkspaceId || session.tokenWorkspaceId === workspaceId
}

/** Keep the familiar route adapter surface; OAuth and handoff code imports
 * lib/auth directly and continues to require a real browser session. */
export const auth = { api: { getSession: getApiSession } }

