import { withRequestLog } from '@/lib/request-log'
import { auth, authBaseURL } from '@/lib/auth'
import { BASE_PATH } from '@/lib/base-path'
import { verificationNavigationResponse } from '@/lib/auth-verification-response'
import { handleGitHubConnectCallback } from '@/lib/github/connect-callback'

/** Better Auth answers a Fetch Request; the framework wrapper only forwarded to
 * this same handler under five method names. */
const handler = (request: Request) => auth.handler(request)

// The API hands route handlers the URL without its base path, but better-auth
// matches routes against its full base URL (/mikka/api/auth), so put it back.
function withBasePathURL(route: (request: Request) => Promise<Response>) {
  return (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith(`${BASE_PATH}/`)) return route(request)
    url.pathname = `${BASE_PATH}${url.pathname}`
    return route(new Request(url, { method: request.method, headers: request.headers, body: request.body, duplex: 'half' } as RequestInit))
  }
}

export const GET = withRequestLog('/api/auth/[...all]', withBasePathURL(async request => await handleGitHubConnectCallback(request) ?? verificationNavigationResponse(
  request, await handler(request), authBaseURL ?? 'http://localhost:3000',
)))
export const POST = withRequestLog('/api/auth/[...all]', withBasePathURL(handler))
