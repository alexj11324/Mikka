import { canonicalWebServer, WEB_CONNECTION_PROTOCOL } from './policy'

export type WebServer = { url: string; name: string; version: string; edition: 'cloud' | 'community'; signIn: { email: boolean; google: boolean; github: boolean } }
export type WebServerProbe =
  | { status: 'ok'; server: WebServer }
  | { status: 'invalid_address' | 'https_required' | 'unreachable' | 'not_mikka' }
  | { status: 'web_disabled' }
  | { status: 'server_update_required'; version: string | null }
  | { status: 'app_update_required'; minimum: string | null }
export type WebFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const field = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

async function json(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || Number(response.headers.get('content-length')) > 65_536 || !response.body) return null
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > 65_536) { await reader.cancel(); return null }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return null }
}

/** A browser probes directly: the cloud never fetches a supplied address and
 * never sees this installation's login or credentials. No redirects or cookies. */
export async function probeWebServer(input: unknown, options: { fetch: WebFetch; timeoutMs?: number }): Promise<WebServerProbe> {
  if (typeof input !== 'string') return { status: 'invalid_address' }
  const text = input.trim()
  if (/^http:\/\//i.test(text)) return { status: 'https_required' }
  const base = canonicalWebServer(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  if (!base) return { status: 'invalid_address' }
  const address = new URL(base)
  const paths = address.pathname === '/' ? ['', '/mikka'] : [address.pathname]
  let reachable = false, older = false
  const get = (url: string) => options.fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) })
  for (const path of paths) {
    const candidate = `${address.origin}${path}`
    try {
      const response = await get(`${candidate}/api/desktop/discovery`)
      reachable = true
      const body = record(await json(response))
      if (response.status === 426) return { status: 'app_update_required', minimum: field(body?.minWebVersion, 100) }
      const name = field(body?.name, 200), version = field(body?.version, 100)
      const edition = body?.edition
      const serverBase = typeof body?.basePath === 'string' && (body.basePath.startsWith('/') || body.basePath === '') ? canonicalWebServer(`${address.origin}${body.basePath}`) : null
      const signIn = record(body?.signIn)
      if (response.ok && name && version && (edition === 'cloud' || edition === 'community') && serverBase && (address.pathname === '/' || serverBase === candidate) && signIn && ['email', 'google', 'github'].every(key => typeof signIn[key] === 'boolean')) {
        const web = record(body?.web), protocol = record(web?.protocol)
        if (!web || !protocol || !Number.isSafeInteger(protocol.min) || !Number.isSafeInteger(protocol.max) || (protocol.min as number) > (protocol.max as number)) return { status: 'server_update_required', version }
        if ((protocol.max as number) < WEB_CONNECTION_PROTOCOL) return { status: 'server_update_required', version }
        if ((protocol.min as number) > WEB_CONNECTION_PROTOCOL) return { status: 'app_update_required', minimum: field(body?.minWebVersion, 100) }
        if (web.enabled !== true) return { status: 'web_disabled' }
        return { status: 'ok', server: { url: serverBase, name, version, edition, signIn: { email: signIn.email as boolean, google: signIn.google as boolean, github: signIn.github as boolean } } }
      }
      const legacy = record(await json(await get(`${candidate}/api/version`)))
      if (typeof legacy?.build === 'string' && 'minDesktopVersion' in legacy) older = true
    } catch { /* A different base path may still identify this exact origin. */ }
  }
  return older ? { status: 'server_update_required', version: null } : { status: reachable ? 'not_mikka' : 'unreachable' }
}
