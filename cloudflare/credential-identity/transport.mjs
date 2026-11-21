import { boundedJson } from '../bounded-json.mjs'

const deny = status => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

export async function identityRequest(request, binding) {
  if (request.url !== 'https://identity.internal/token' || request.method !== 'POST') return deny(404)
  if (request.body) {
    const reader = request.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.byteLength) { await reader.cancel(); return deny(404) }
      }
    } catch { return deny(404) }
    finally { reader.releaseLock() }
  }
  if (!binding) return deny(503)
  return binding.fetch(new Request('https://identity.internal/token', { method: 'POST', redirect: 'manual' }))
}

/** This route is reached only through the app's configured private service binding. */
export async function brokerRequest(request, send) {
  if (request.url !== 'https://broker.internal/api/fill' || request.method !== 'POST') return deny(404)
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return deny(415)
  let input
  try { input = await boundedJson(request, 12_288) }
  catch (error) { return deny(error instanceof RangeError ? 413 : 400) }
  if (!input || typeof input !== 'object' || Object.keys(input).join() !== 'lease' || typeof input.lease !== 'string') return deny(400)
  try {
    return await send(new Request('https://broker.internal/api/fill', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lease: input.lease }), redirect: 'manual',
    }))
  } catch { return deny(503) }
}
