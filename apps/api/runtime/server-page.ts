import { isCloudEdition } from '../../../lib/edition'
import { serverPageKind } from '../../../lib/server-pages'
import { applySecurityHeaders, isPagePath, pageResponse, prefersServerHtml } from './http-policy.mjs'

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
  const info = await serverInfo(request)
  // Existing API clients keep the v1 JSON response. Browsers get the same
  // bounded public viewmodel, embedded once without a session or another GET.
  info.headers.append('vary', 'Accept')
  if (!prefersServerHtml(request)) {
    return applySecurityHeaders(request, info)
  }
  const page = await pageResponse(request, async () => {
    const data = JSON.stringify(await info.json()).replaceAll('<', '\\u003c')
    return spaHtml.replace(/(<html\b[^>]*)(>)/, '$1 data-mikka-server-page="status"$2')
      .replace('</head>', () => `<script type="application/json" id="mikka-server-info">${data}</script></head>`)
  })
  page.headers.append('vary', 'Accept')
  page.headers.set('referrer-policy', 'no-referrer')
  return page.status === 200 && info.status !== 200
    ? new Response(page.body, { status: info.status, headers: page.headers }) : page
}
