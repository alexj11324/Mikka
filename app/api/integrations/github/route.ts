import { GitHubAccessError, listAuthorizedRepositories } from '@/lib/github/user-access'
import { auth } from '@/lib/auth'
import { withRequestLog } from '@/lib/request-log'

const headers = { 'Cache-Control': 'private, no-store' }

async function handleGET(request: Request) {
  let viewerId: string | null = null
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) throw new GitHubAccessError('authRequired', 401)
    viewerId = session.user.id
    const result = await listAuthorizedRepositories(request.headers)
    if (result.userId !== viewerId) throw new GitHubAccessError('authRequired', 401)
    return Response.json({ viewerId, configured: true, connected: true, installed: result.installations.length > 0, repositories: result.repositories }, { headers })
  } catch (error) {
    if (error instanceof GitHubAccessError) {
      if (viewerId && (error.code === 'githubNotConnected' || error.code === 'githubNotConfigured')) return Response.json({ viewerId, configured: error.code !== 'githubNotConfigured', connected: false, installed: false, repositories: [] }, { headers })
      return Response.json({ ...(viewerId ? { viewerId } : {}), error: error.code }, { status: error.status, headers })
    }
    return Response.json({ ...(viewerId ? { viewerId } : {}), error: 'githubUnavailable' }, { status: 502, headers })
  }
}

export const GET = withRequestLog('/api/integrations/github', handleGET)
