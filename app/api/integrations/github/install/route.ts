import { auth } from '@/lib/api-auth'
import { githubAppInstallUrl } from '@/lib/github/install-url'
import { withRequestLog } from '@/lib/request-log'

export const GET = withRequestLog('/api/integrations/github/install', async (request: Request) => {
  const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const url = githubAppInstallUrl()
  if (!url) return Response.json({ error: 'githubNotConfigured' }, { status: 503, headers })
  return new Response(null, { status: 302, headers: { ...headers, Location: url } })
})
