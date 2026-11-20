import 'server-only'
import { auth } from '@/lib/auth'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import type { ArtifactReader } from './access'

/** Restricted links use a current browser/native session, never a body user id.
 * The share reader calls this only for a private/workspace link. */
export async function artifactShareViewer(request: Request): Promise<ArtifactReader | null> {
  if (!request.headers.has('cookie') && !request.headers.has('authorization')) return null
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  return session?.user ? { id: session.user.id,
    [enterprisePrincipal]: { kind: 'session', sessionId: session.session.id } } : null
}
