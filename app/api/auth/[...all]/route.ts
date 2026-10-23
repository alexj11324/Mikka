import { withRequestLog } from '@/lib/request-log'
import { auth } from '@/lib/auth'
import { BASE_PATH } from '@/lib/base-path'
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

export const GET = withRequestLog('/api/auth/[...all]', withBasePathURL(handler.GET))
export const POST = withRequestLog('/api/auth/[...all]', withBasePathURL(handler.POST))
