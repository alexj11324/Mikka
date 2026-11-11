/** The eve service owns its protocol and authentication. This proxy supplies
 * the app's same-origin mount without interpreting or buffering its events. */
export const EVE_PUBLIC_PREFIX = '/mikka/api/agents'

export function eveServiceOrigin(env: Record<string, string | undefined> = process.env): URL {
  const value = env.MIKKA_EVE_ORIGIN ?? 'http://127.0.0.1:3002'
  const origin = new URL(value)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('EVE_SERVICE_ORIGIN_INVALID')
  return origin
}

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']

export function eveProxyPath(request: Request, upstreamPath?: string): string {
  const original = new URL(request.url)
  const path = upstreamPath ?? (original.pathname.startsWith(`${EVE_PUBLIC_PREFIX}/`) ? original.pathname.slice(EVE_PUBLIC_PREFIX.length) : '')
  if (!path.startsWith('/eve/v1/') && !path.startsWith('/.well-known/workflow/')) throw new Error('EVE_PROXY_PATH_INVALID')
  if (/[\\?#]/.test(path) || /%2f|%5c|%2e|\/\.\.?\//i.test(path)) throw new Error('EVE_PROXY_PATH_INVALID')
  return path
}

export async function proxyEveRequest(request: Request, upstreamPath?: string, options: {
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
} = {}): Promise<Response> {
  let target: URL
  try {
    target = new URL(eveProxyPath(request, upstreamPath), eveServiceOrigin(options.env))
    target.search = new URL(request.url).search
  } catch {
    return Response.json({ ok: false, error: 'notFound' }, { status: 404 })
  }
  const headers = new Headers(request.headers)
  // Connection can nominate additional hop-by-hop fields.
  for (const name of (headers.get('connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim())
  for (const name of hopHeaders) headers.delete(name)
  headers.set('x-forwarded-host', new URL(request.url).host)
  headers.set('x-forwarded-proto', new URL(request.url).protocol.slice(0, -1))
  try {
    const response = await (options.fetch ?? fetch)(target, {
      method: request.method, headers, signal: request.signal, redirect: 'manual',
      ...(!['GET', 'HEAD'].includes(request.method) && request.body ? { body: request.body, duplex: 'half' } : {}),
    } as RequestInit)
    const outputHeaders = new Headers(response.headers)
    for (const name of hopHeaders) outputHeaders.delete(name)
    outputHeaders.set('cache-control', 'private, no-store')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders })
  } catch (error) {
    if (request.signal.aborted) throw error
    // URL, cookie and provider error messages must not enter an error body.
    return Response.json({ ok: false, error: 'coordinatorUnavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
