import { auth } from '@/lib/api-auth'
import { githubAppInstallUrlFromSlug } from '@/lib/github/install-url'
import { readGitHubAppConfig } from '@/lib/github/app-config'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'
import { beginCloudGitHubInstallation } from '@/lib/github/cloud'
import { CloudServiceError, cloudErrorStatus } from '@/lib/cloud-services/errors'

export const GET = withRequestLog('/api/integrations/github/install', freshSessionRoute(async (request: Request) => {
  const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  let cloudUrl: string | null
  try { cloudUrl = await beginCloudGitHubInstallation(session.user.id) }
  catch (error) {
    if (error instanceof CloudServiceError) return Response.json({ error: error.code }, { status: cloudErrorStatus(error.code), headers })
    throw error
  }
  const url = cloudUrl ?? githubAppInstallUrlFromSlug((await readGitHubAppConfig()).slug)
  if (!url) return Response.json({ error: 'githubNotConfigured' }, { status: 503, headers })
  return new Response(null, { status: 302, headers: { ...headers, Location: url } })
}))
