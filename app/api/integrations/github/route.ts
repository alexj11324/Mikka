import { GitHubAccessError, listAuthorizedRepositories } from '@/lib/github/user-access'
import { auth } from '@/lib/api-auth'
import { auth as sessionAuth } from '@/lib/auth'
import { withRequestLog } from '@/lib/request-log'
import { disconnectGitHub, githubConnection } from '@/lib/github/connection'

const headers = { 'Cache-Control': 'private, no-store' }

async function handleGET(request: Request) {
  let viewerId: string | null = null
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) throw new GitHubAccessError('authRequired', 401)
    viewerId = session.user.id
    const result = await listAuthorizedRepositories(request.headers)
    if (result.userId !== viewerId) throw new GitHubAccessError('authRequired', 401)
    const connection = await githubConnection(viewerId)
    return Response.json({ viewerId, configured: true, connected: true, login: connection?.githubLogin ?? null, installed: result.installations.length > 0, repositories: result.repositories }, { headers })
  } catch (error) {
    if (error instanceof GitHubAccessError) {
      if (viewerId && (error.code === 'githubNotConnected' || error.code === 'githubNotConfigured')) return Response.json({ viewerId, configured: error.code !== 'githubNotConfigured', connected: false, installed: false, repositories: [] }, { headers })
      return Response.json({ ...(viewerId ? { viewerId } : {}), error: error.code }, { status: error.status, headers })
    }
    return Response.json({ ...(viewerId ? { viewerId } : {}), error: 'githubUnavailable' }, { status: 502, headers })
  }
}

/** Removes only this user's Plugins → GitHub connection; the GitHub sign-in stays. */
async function handleDELETE(request: Request) {
  const session = await sessionAuth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  await disconnectGitHub(session.user.id)
  return Response.json({ viewerId: session.user.id }, { headers })
}

export const GET = withRequestLog('/api/integrations/github', handleGET)
export const DELETE = withRequestLog('/api/integrations/github', handleDELETE)
