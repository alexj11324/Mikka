// Sends the cloud endpoints that have a local substitute to the loopback
// services (scripts/dev/local-services.mjs). Every other request is untouched.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Cloud URL → local URL, or null when the request is not substituted. */
export function localRoute(href, origin) {
  const url = new URL(href)
  if (url.protocol !== 'https:') return null
  if (url.hostname === 'ai-gateway.vercel.sh') return `${origin}/gateway${url.pathname}${url.search}`
  if (url.hostname === 'api.resend.com' && url.pathname === '/emails') return `${origin}/resend/emails`
  return null
}

export function assertLoopbackOrigin(origin) {
  let url
  try { url = new URL(origin) } catch { throw new Error('Local services origin is not a URL') }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('Local services origin must be a plain http loopback origin')
  return url.origin
}

export function installLocalTransport(origin, upstreamFetch = globalThis.fetch) {
  const base = assertLoopbackOrigin(origin)
  const transport = (input, init) => {
    const request = new Request(input, init)
    const target = localRoute(request.url, base)
    return target ? upstreamFetch(new Request(target, request)) : upstreamFetch(input, init)
  }
  globalThis.fetch = transport
  return () => { if (globalThis.fetch === transport) globalThis.fetch = upstreamFetch }
}
