import { isCloudEdition } from '../../../lib/edition'
import { serverPageKind } from '../../../lib/server-pages'
import { applySecurityHeaders, isPagePath, pageResponse } from './http-policy.mjs'

type Environment = Record<string, string | undefined>

/** The backend owns dispatch and the public viewmodel; Claude's page can use
 * the same /api/server contract without coupling its layout to this router. */
export async function serverPageResponse(request: Request, spaHtml: string, serverInfo: (request: Request) => Promise<Response>, env: Environment = process.env) {
  if (isCloudEdition(env)) return pageResponse(request, () => spaHtml)
  const url = new URL(request.url)
  if (!isPagePath(url.pathname)) return applySecurityHeaders(request, new Response(null, { status: 404 }))
  if (!['GET', 'HEAD'].includes(request.method)) return applySecurityHeaders(request, new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }))
  const kind = serverPageKind(url)
  if (kind) {
    const response = await pageResponse(request, () => spaHtml.replace(/(<html\b[^>]*)(>)/, `$1 data-mikka-server-page="${kind}"$2`))
    response.headers.set('referrer-policy', 'no-referrer')
    return response
  }
  return applySecurityHeaders(request, await serverInfo(request))
}
