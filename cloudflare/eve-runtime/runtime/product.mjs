import { timingSafeEqual } from 'node:crypto'

export function equalCapability(supplied, capability) {
  const actual = Buffer.from(supplied ?? '')
  const expected = Buffer.from(capability ?? '')
  return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected)
}

const path = '/mikka/api/internal/eve/tools'

/** Only Eve's configured product client may enter this immutable business service. */
export function productRequest(request, api, publicOrigin, capability) {
  if (request.method !== 'POST' || request.url !== 'https://product.internal' + path) return new Response(null, { status: 404 })
  const auth = request.headers.get('authorization')
  if (!equalCapability(request.headers.get('x-mikka-product-capability'), capability)
      || !auth?.startsWith('Bearer mev_')) return new Response(null, { status: 403 })
  if (!api?.fetch) return new Response(null, { status: 503 })
  return api.fetch(new Request(new URL(path, publicOrigin), {
    method: 'POST', body: request.body, signal: request.signal, redirect: 'error', duplex: 'half',
    headers: { 'content-type': 'application/json', authorization: auth },
  }))
}
