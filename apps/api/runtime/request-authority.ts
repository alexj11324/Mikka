import type { ServerRequest } from 'srvx'
import { CodedError } from '@mikka/protocol/coded-error'
import { pageRedirect } from './http-policy.mjs'
import { isLoopbackHost } from '../../../lib/loopback'

type Handler = (request: ServerRequest) => Response | Promise<Response>
type Configuration = { origin: string | undefined; legacyHost?: string }
type ConfigurationDetail = 'missing_origin' | 'invalid_origin' | 'invalid_legacy_host'
const invalid = (detail: ConfigurationDetail, cause?: unknown): never => {
  throw new CodedError('API_REQUEST_AUTHORITY_CONFIG_INVALID', { detail, ...(cause === undefined ? {} : { cause }) })
}

function configuredOrigin(value: string | undefined, allowLoopback = false): URL {
  if (!value) return invalid('missing_origin')
  let url: URL
  try { url = new URL(value) } catch (error) { return invalid('invalid_origin', error) }
  if ((url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && isLoopbackHost(url.hostname))) || url.origin !== value) return invalid('invalid_origin')
  return url
}

function configuredLegacyHost(host: string): string {
  let url: URL
  try { url = new URL(`https://${host}`) } catch (error) { return invalid('invalid_legacy_host', error) }
  if (url.host !== host || url.port) return invalid('invalid_legacy_host')
  return url.host
}

const rejected = () => Object.assign(new Response(null, { status: 400, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }), {
  // Nitro's crossws adapter resolves hooks even when fetch returned HTTP 400.
  crossws: { upgrade() { throw new Response(null, { status: 400 }) } },
})

/** A self-hosted reverse proxy supplies the configured Host. No incoming proxy
 * header can invent an authority; plain HTTP is supported only on loopback. */
export function withNodeRequestAuthority(fetch: Handler, configuration: Configuration): Handler {
  const canonical = configuredOrigin(configuration.origin, true)
  const origins = new Map([[canonical.host, canonical.origin]])
  const legacy = configuration.legacyHost ? configuredLegacyHost(configuration.legacyHost) : undefined
  if (legacy && origins.has(legacy)) return invalid('invalid_legacy_host')

  return request => {
    const node = request.runtime?.node
    // Internal serverFetch calls have no HTTP ingress and keep their supplied URL.
    if (!node) return fetch(request)
    const http2 = node.req.httpVersionMajor === 2
    const raw = node.req.rawHeaders
    if (!Array.isArray(raw) || raw.length % 2) return rejected()
    const critical = new Map<string, string>()
    for (let index = 0; index < raw.length; index += 2) {
      const name = raw[index]?.toLowerCase(), value = raw[index + 1]
      if (!(http2 && name === ':authority') && !['host', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'].includes(name)) continue
      // Vercel's documented carrier is X-Forwarded-*. Reject a competing RFC
      // Forwarded authority instead of interpreting an arbitrary proxy chain.
      if (critical.has(name) || typeof value !== 'string' || name === 'forwarded') return rejected()
      critical.set(name, value)
    }
    // HTTP/2 carries the authority in a pseudo-header that Fetch Headers omits.
    // Both protocol versions still select from the configured origins only.
    const hostHeader = critical.get('host')
    const authority = http2 ? critical.get(':authority') : undefined
    const host = authority ?? hostHeader
    if (!host || (host !== legacy && !origins.has(host))
      || (hostHeader !== undefined && (hostHeader !== host || request.headers.get('host') !== hostHeader))
      || (authority !== undefined && node.req.headers[':authority'] !== authority)
      || (critical.has('x-forwarded-host') && critical.get('x-forwarded-host') !== host)
      || (critical.has('x-forwarded-proto') && critical.get('x-forwarded-proto') !== (host === legacy ? 'https' : new URL(origins.get(host)!).protocol.slice(0, -1)))) return rejected()
    const target = node.req.url
    // Authority is selected above, solely by exact configured Host. Never let
    // an absolute-form, network-path or backslash target choose another one.
    // oxlint-disable-next-line no-control-regex -- Validate the raw HTTP origin-form target before URL construction.
    if (!target || !target.startsWith('/') || target.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(target)) return rejected()
    const absolute = new URL(target, host === legacy ? `https://${legacy}` : origins.get(host))
    // Set the parsed URL before H3/the lazy native Request reads it. Preserve
    // the same body, abort, req/res and waitUntil.
    request._url = absolute
    if (request.url !== absolute.href) return rejected()
    if (host === legacy) return pageRedirect(request, { legacyHost: legacy, origin: canonical.origin }) ?? rejected()
    return fetch(request)
  }
}
