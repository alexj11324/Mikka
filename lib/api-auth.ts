import 'server-only'
import { auth as sessionAuth } from '@/lib/auth'
import { tokenWorkspace } from '@/lib/tokens/principal'

type BrowserSession = NonNullable<Awaited<ReturnType<typeof sessionAuth.api.getSession>>>
export type ApiSession = { user: Pick<BrowserSession['user'], 'id' | 'name' | 'email' | 'image'> & { [tokenWorkspace]?: string }; session: { id: string }; tokenWorkspaceId?: string }

/** PATs authenticate only the owner's ordinary API identity. They do not mint
 * cookies or a browser session, nor bypass a route's existing authorization. */
export async function getApiSession(options: { headers: Headers; query?: { disableCookieCache?: boolean; disableRefresh?: boolean } }): Promise<ApiSession | null> {
  const authorization = options.headers.get('authorization')
  // An explicitly supplied PAT wins over a cookie, including when invalid.
  if (!/^Bearer\s+mkp_/i.test(authorization ?? '')) return sessionAuth.api.getSession(options)
  const token = /^Bearer (mkp_[A-Za-z0-9_-]{43})$/i.exec(authorization!)?.[1]
  if (!token) return null
  const { verifyPersonalAccessToken } = await import('@/lib/tokens/store')
  const principal = await verifyPersonalAccessToken(token)
  if (!principal) return null
  const [{ workspaceDb }, { requireWorkspace, WorkspaceError }, { db }, { users }, { eq }] = await Promise.all([
    import('@/lib/workspace-db'), import('@/lib/workspace-access'), import('@/lib/db'), import('@/lib/db/schema'), import('drizzle-orm'),
  ])
  try { await workspaceDb.transaction(tx => requireWorkspace(tx, principal.workspaceId, principal.userId)) }
  catch (error) { if (error instanceof WorkspaceError) return null; throw error }
  const [user] = await db.select().from(users).where(eq(users.id, principal.userId)).limit(1)
  if (!user) return null
  // The scope accompanies the authenticated user into the existing workspace
  // resolver, without appearing in serialized user responses.
  Object.defineProperty(user, tokenWorkspace, { value: principal.workspaceId })
  return { user, session: { id: `pat:${principal.tokenId}` }, tokenWorkspaceId: principal.workspaceId }
}

export function apiWorkspaceAllowed(session: ApiSession, workspaceId: string) {
  return !session.tokenWorkspaceId || session.tokenWorkspaceId === workspaceId
}

/** Keep the familiar route adapter surface; OAuth and handoff code imports
 * lib/auth directly and continues to require a real browser session. */
export const auth = { api: { getSession: getApiSession } }

