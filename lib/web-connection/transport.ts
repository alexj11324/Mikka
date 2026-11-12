import { OFFICIAL_WEB_URL, officialWebOriginAllowed, webConnectionURL, type WebConnectionEnvironment } from './policy'
import { NextRequest } from '../../apps/api/compat/server'
import { parseRequestCookies } from '../../apps/api/src/request-cookies.mjs'
import { selectedWorkspaceId, WORKSPACE_SELECTION_HEADER, workspaceSelection } from '../workspace-selection'

const allowedHeaders = [
  'accept', 'authorization', 'content-type', 'range', 'if-none-match', 'last-event-id',
  'x-mikka-client', 'x-mikka-client-version', 'x-mikka-web-protocol', 'x-mikka-desktop-protocol',
  'x-mikka-locale', 'x-mikka-credential', 'x-mikka-stream-key', 'x-mikka-deletion-receipt',
  WORKSPACE_SELECTION_HEADER,
]
const exposedHeaders = [
  'content-disposition', 'content-length', 'content-range', 'etag', 'x-mikka-session-token',
  'x-mikka-stream-key', 'x-mikka-stream-reset', 'x-mikka-stream-run', 'x-mikka-observed-at', 'x-mikka-viewer',
  WORKSPACE_SELECTION_HEADER,
]
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const publicPaths = new Set(['/api/desktop/discovery', '/api/server', '/api/version', '/api/web/begin', '/api/web/exchange'])
const blockedPaths = /^\/api\/(?:auth(?:\/|$)|rpc$|cron(?:\/|$)|webhooks(?:\/|$)|desktop\/(?:begin|return|exchange|finish)(?:\/|$)|web\/(?:return|complete)(?:\/|$))/
const bearer = /^Bearer [A-Za-z0-9_.%~+/-]{32,512}$/

export type WebTransportIdentity = { session: { id: string }; user: { id: string } }
export type WebTransport = {
  request: Request
  run<T>(work: () => T): T
  response(response: Response): Response
}
export type PrepareWebTransport = (request: Request, route: string) => Promise<WebTransport | Response | null>

function corsResponse(response: Response, origin: string, additionalHeaders: string[] = []) {
  const headers = new Headers(response.headers)
  // Existing workspace actions acknowledge their validated choice through a
  // preference cookie. Expose only that preference to a bearer-only client;
  // authentication cookies and cache proofs still never cross this boundary.
  headers.delete(WORKSPACE_SELECTION_HEADER)
  if (response.ok) for (const cookie of response.headers.getSetCookie()) {
    const value = parseRequestCookies(cookie.split(';', 1)[0]).get('mikka-workspace')
    if (value === '') headers.set(WORKSPACE_SELECTION_HEADER, '')
    else if (value !== undefined) {
      const workspaceId = selectedWorkspaceId(value)
      if (workspaceId) headers.set(WORKSPACE_SELECTION_HEADER, workspaceId)
    }
  }
  // Cross-origin browser clients never receive or rely on a Cookie proof.
  headers.delete('set-cookie')
  headers.delete('x-mikka-session-cache')
  headers.delete('access-control-allow-credentials')
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-expose-headers', [...exposedHeaders, ...additionalHeaders].join(', '))
  headers.set('cache-control', 'private, no-store')
  headers.set('vary', [...new Set([...(headers.get('vary') ?? '').split(',').map(value => value.trim()).filter(Boolean), 'Origin', 'Authorization'])].join(', '))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
const rejected = (status: number, code: string) => Response.json({ error: { code } }, { status, headers: { 'cache-control': 'no-store', vary: 'Origin' } })

/** An explicit transport adapter, like the native RPC boundary. A foreign
 * Origin is never rewritten until its exact configured public client AND its
 * fresh database bearer identity pass. The adapted request carries no browser
 * cookies/cache proof. Existing REST handlers independently authenticate the
 * retained bearer and enforce their own action authorization; this boundary
 * does not synthesize a Better Auth session or a client-controlled identity.
 * The original request remains the trace source. */
export function createWebTransport(options: {
  env?: WebConnectionEnvironment
  authenticate(headers: Headers): Promise<WebTransportIdentity | null>
  scope<T>(identity: WebTransportIdentity, work: () => T): T
}): PrepareWebTransport {
  return async (request, route) => {
    const origin = request.headers.get('origin')
    if (!origin || origin === new URL(request.url).origin) return null
    // Other cross-origin/native transports retain their own independent guards.
    if (!officialWebOriginAllowed(origin, options.env)) {
      const configured = webConnectionURL(options.env) ?? OFFICIAL_WEB_URL
      if (origin !== new URL(configured).origin) return null
      // Discovery is public and can explain the administrator's disabled state.
      // No handoff or existing session remains usable after the kill switch.
      if (route !== '/api/desktop/discovery') return corsResponse(rejected(403, 'web_connection_disabled'), origin)
    }
    if (blockedPaths.test(route)) return corsResponse(rejected(403, 'web_connection_route_refused'), origin)
    const method = request.method.toUpperCase()
    if (method === 'OPTIONS') {
      const requestedMethod = request.headers.get('access-control-request-method')
      const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean)
      // Eve uses this immutable key to recognize a retried chat turn.
      const headers = route.startsWith('/api/agents/') ? [...allowedHeaders, 'x-mikka-submission-id'] : allowedHeaders
      if (!requestedMethod || !methods.includes(requestedMethod) || requestedHeaders.some(value => !headers.includes(value))) return corsResponse(rejected(403, 'web_connection_preflight_refused'), origin)
      return corsResponse(new Response(null, { status: 204, headers: {
        'access-control-allow-methods': methods.join(', '), 'access-control-allow-headers': headers.join(', '),
      } }), origin)
    }
    if (!methods.includes(method)) return corsResponse(rejected(405, 'web_connection_method_refused'), origin)
    const finish = (response: Response) => corsResponse(response, origin)
    if (publicPaths.has(route)) {
      // A discovery/handoff never consumes ambient or caller-supplied authority.
      const headers = new Headers(request.headers)
      for (const name of ['cookie', 'authorization', 'x-mikka-session-cache', 'x-mikka-session-token']) headers.delete(name)
      // The shared adapter unwraps srvx's native backing request. Constructing
      // a native Request directly from its Node facade fails Undici's private
      // state check; the outer H3 event still owns disposal and waitUntil.
      return { request: new NextRequest(request, { headers }), run: work => work(), response: finish }
    }
    const authorization = request.headers.get('authorization')
    if (!authorization || !bearer.test(authorization) || /^Bearer (?:mkp_|mka_|mkr_)/.test(authorization)) return finish(rejected(401, 'web_connection_session_expired'))
    const headers = new Headers(request.headers)
    for (const name of ['cookie', 'x-mikka-session-cache', 'x-mikka-session-token', 'x-deployment-id', 'x-mikka-rpc']) headers.delete(name)
    // The authenticator receives only the selected server's bearer, never the
    // official cloud's cookie and never a client-issued session cache proof.
    let identity: WebTransportIdentity | null
    try { identity = await options.authenticate(new Headers({ authorization })) }
    catch { return finish(rejected(503, 'web_connection_auth_unavailable')) }
    if (!identity) return finish(rejected(401, 'web_connection_session_expired'))
    const selection = workspaceSelection(headers)
    if (selection.present && !selection.workspaceId) return finish(rejected(403, 'workspaceAccessDenied'))
    // Handoff revoke verifies the original official Origin itself. Other REST
    // routes use the server's already-authenticated native transport semantics.
    if (route !== '/api/web/revoke') {
      headers.set('origin', new URL(request.url).origin)
      headers.set('sec-fetch-site', 'same-origin')
    }
    return { request: new NextRequest(request, { headers }), run: work => options.scope(identity, work), response: response => {
      // The Eve client validates the schema before reading a line and uses the tail for replay.
      const stream = method === 'GET' && route.startsWith('/api/agents/') && new URL(request.url).pathname.endsWith('/stream')
        && response.ok && response.headers.get('content-type')?.split(';')[0]?.trim() === 'application/x-ndjson'
      const readable = stream ? ['x-eve-stream-version', 'x-eve-stream-tail-index'].filter(name => response.headers.has(name)) : []
      return corsResponse(response, origin, readable)
    } }
  }
}
