import type { ServerRequest } from 'srvx'
import { CodedError } from '@mikka/protocol/coded-error'
import { pageRedirect } from './http-policy.mjs'
import { isLoopbackHost } from '../../../lib/loopback'

type Handler = (request: ServerRequest) => Response | Promise<Response>
type Configuration = { origin: string | undefined; deploymentHost?: string; productionHost?: string; legacyHost?: string }
type ConfigurationDetail = 'missing_origin' | 'invalid_origin' | 'invalid_platform_host'
const invalid = (detail: ConfigurationDetail, cause?: unknown): never => {
  throw new CodedError('API_VERCEL_AUTHORITY_CONFIG_INVALID', { detail, ...(cause === undefined ? {} : { cause }) })
}

function configuredOrigin(value: string | undefined, allowLoopback = false): URL {
  if (!value) return invalid('missing_origin')
  let url: URL
  try { url = new URL(value) } catch (error) { return invalid('invalid_origin', error) }
  if ((url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && isLoopbackHost(url.hostname))) || url.origin !== value) return invalid('invalid_origin')
  return url
}

function platformOrigin(host: string): URL {
  const url = configuredOrigin(`https://${host}`)
  if (url.host !== host || url.port) return invalid('invalid_platform_host')
  return url
}

const rejected = () => Object.assign(new Response(null, { status: 400, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }), {
  // Nitro's crossws adapter resolves hooks even when fetch returned HTTP 400.
  crossws: { upgrade() { throw new Response(null, { status: 400 }) } },
})

/** Vercel supplies Host as visited, X-Forwarded-Host as the same host and a
 * forwarded scheme. Its Nitro Node adapter currently leaves srvx trustProxy
 * off, so a TLS-terminated request otherwise becomes http:// at the app.
 *
 * Only server configuration contributes authorities. Incoming Origin, cookies,
 * authentication and platform-marker headers never add one. The selected host
 * is retained (not rewritten to the main domain), so deployment-local Workflow
 * callbacks continue to reach their own deployment. Browser RPC still compares
 * Origin and the resulting URL against its separate configured app origin.
 * https://vercel.com/docs/headers/request-headers */
export function withVercelRequestAuthority(fetch: Handler, configuration: Configuration): Handler {
  return withConfiguredAuthority(fetch, configuration)
}

/** A self-hosted reverse proxy supplies the configured Host. No incoming proxy
 * header can invent an origin; plain HTTP is supported only on loopback. */
export function withNodeRequestAuthority(fetch: Handler, configuration: Pick<Configuration, 'origin' | 'legacyHost'>): Handler {
  return withConfiguredAuthority(fetch, configuration, true)
}

function withConfiguredAuthority(fetch: Handler, configuration: Configuration, allowLoopback = false): Handler {
  const canonical = configuredOrigin(configuration.origin, allowLoopback)
  const origins = new Map([[canonical.host, canonical.origin]])
  for (const host of [configuration.deploymentHost, configuration.productionHost]) {
    if (host) { const value = platformOrigin(host); origins.set(value.host, value.origin) }
  }
  // This legacy domain has one existing fixed 308 destination, never a route
  // into application data. Preserve that redirect without adding an auth host.
  const legacy = configuration.legacyHost ? platformOrigin(configuration.legacyHost).host : undefined
  if (legacy && origins.has(legacy)) return invalid('invalid_platform_host')

  return request => {
    const node = request.runtime?.node
    // Nitro's private serverFetch can call the app without a Node ingress.
    // Actual external Vercel requests always arrive through toNodeHandler.
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
    // The official SDK exposes its parsed URL. Set it before H3/the lazy native
    // Request reads anything; preserve the same body, abort, req/res and waitUntil.
    request._url = absolute
    if (request.url !== absolute.href) return rejected()
    if (host === legacy) return pageRedirect(request, { legacyHost: legacy, origin: canonical.origin }) ?? rejected()
    return fetch(request)
  }
}
