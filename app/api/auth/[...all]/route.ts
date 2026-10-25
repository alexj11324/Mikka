import { pool } from '@/lib/db'
import { appendAudit } from '@/lib/audit/store'
import { auth, authBaseURL } from '@/lib/auth'
import { BASE_PATH } from '@/lib/base-path'
import { verificationNavigationResponse } from '@/lib/auth-verification-response'
import { toNextJsHandler } from 'better-auth/next-js'

const handler = toNextJsHandler(auth)

// Next hands route handlers the URL without its base path, but better-auth
// matches routes against its full base URL (/mikka/api/auth), so put it back.
function withBasePathURL(route: (request: Request) => Promise<Response>) {
  return (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith(`${BASE_PATH}/`)) return route(request)
    url.pathname = `${BASE_PATH}${url.pathname}`
    return route(new Request(url, { method: request.method, headers: request.headers, body: request.body, duplex: 'half' } as RequestInit))
  }
}

export const GET = withBasePathURL(async request => verificationNavigationResponse(
  request, await handler.GET(request), authBaseURL ?? 'http://localhost:3000',
))
export const POST = withBasePathURL(async request => {
  const response = await handler.POST(request)
  if (response.status >= 400) {
    try {
      await appendAudit(pool, 'system:auth', { actorId: 'anonymous', actorType: 'anonymous', resourceId: 'auth', action: 'auth.denied', outcome: 'denied', reason: `http_${response.status}` })
    } catch { return Response.json({ error: 'auditUnavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
  }
  return response
})
