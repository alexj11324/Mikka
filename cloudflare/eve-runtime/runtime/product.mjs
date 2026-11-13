import { timingSafeEqual } from 'node:crypto'

export function equalCapability(supplied, capability) {
  const actual = Buffer.from(supplied ?? '')
  const expected = Buffer.from(capability ?? '')
  return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected)
}

const paths = new Set(['/mikka/api/internal/eve/tools', '/mikka/api/internal/eve/slack-credential'])

/** Only Eve's configured product client may enter this immutable business service. */
export async function productRequest(request, api, publicOrigin, capability) {
  const path = new URL(request.url).pathname
  if (request.method !== 'POST' || !paths.has(path) || request.url !== 'https://product.internal' + path) return new Response(null, { status: 404 })
  const scope = request.headers.get('x-mikka-eve-scope')
  if (!equalCapability(request.headers.get('x-mikka-product-capability'), capability)
      || !scope || scope.length > 2048) return new Response(null, { status: 403 })
  const proof = path.endsWith('/slack-credential') ? request.headers.get('x-mikka-slack-grant') : null
  if (path.endsWith('/slack-credential') && !proof) return new Response(null, { status: 403 })
  if (!api?.eveProduct) return new Response(null, { status: 503 })
  const response = await api.eveProduct(new Request(new URL(path, publicOrigin), {
    method: 'POST', body: request.body, signal: request.signal, redirect: 'manual', duplex: 'half',
    headers: { 'content-type': 'application/json',
      ...(proof ? { 'x-mikka-slack-grant': proof } : {}) },
  }), scope)
  if (response.status >= 300 && response.status < 400) {
    // A reset during cleanup still leaves the redirect unsafe to return.
    await response.body?.cancel().catch(() => {})
    return new Response(null, { status: 502 })
  }
  return response
}
