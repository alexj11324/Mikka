import { dispatchRpc, rpcFailure, type RpcDispatchOptions } from '../desktop-rpc/handler'

const privateHeaders = ['authorization', 'x-mikka-session-cache', 'x-mikka-session-token']

/** A separate cookie-authenticated transport. A trusted deployment origin is
 * supplied by server configuration; neither Host nor arbitrary proxy headers
 * can expand the browser CSRF boundary. */
export function browserRpcOrigin(request: Request, trustedBaseURL: string | undefined): boolean {
  if (!trustedBaseURL || request.headers.get('x-mikka-rpc') !== '1' || privateHeaders.some(name => request.headers.has(name))) return false
  try {
    const expected = new URL(trustedBaseURL)
    if (!['http:', 'https:'].includes(expected.protocol) || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash) return false
    if (request.headers.get('origin') !== expected.origin || new URL(request.url).origin !== expected.origin) return false
    const site = request.headers.get('sec-fetch-site')
    return site === null || site === 'same-origin'
  } catch { return false }
}

export function createBrowserRpc<Session>(options: RpcDispatchOptions<Session> & {
  trustedBaseURL: string | undefined
  authenticate: (headers: Headers) => Promise<Session | null>
}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return rpcFailure(405, 'desktop_rpc_request_invalid', undefined, 'Cookie')
    if (!browserRpcOrigin(request, options.trustedBaseURL)) return rpcFailure(403, 'desktop_rpc_request_invalid', undefined, 'Cookie')
    let session: Session | null
    try { session = await options.authenticate(request.headers) } catch { return rpcFailure(503, 'desktop_rpc_failed', undefined, 'Cookie') }
    if (!session) return rpcFailure(401, 'desktop_session_expired', undefined, 'Cookie')
    return dispatchRpc(options, request, session, 'Cookie')
  }
}
