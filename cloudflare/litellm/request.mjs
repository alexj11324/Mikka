const postPaths = new Set([
  '/v1/chat/completions', '/v1/decisions', '/v1/audio/transcriptions',
  '/v1/messages', '/v1/messages/count_tokens', '/v1/responses',
])

export function isLiteLlmRoute(method, path) {
  return method === 'POST' && postPaths.has(path) || method === 'GET' && path === '/v1/mikka/catalog'
}

export function converterRequest(request) {
  const url = new URL(request.url)
  if (url.search || !isLiteLlmRoute(request.method, url.pathname)) return null
  return new Request('http://litellm' + url.pathname, request)
}

// The serving and rollback API send raw BYOK model names with bearer auth.
// Prepared APIs send explicit route names under x-litellm-api-key.
export async function converterCompatibilityRequest(request) {
  const path = new URL(request.url).pathname
  if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens', '/v1/responses'].includes(path)
    || !request.headers.has('authorization') || request.headers.has('x-litellm-api-key')) return request
  const payload = await request.clone().json().catch(() => null)
  if (typeof payload?.model !== 'string' || !payload.model || typeof payload.api_key !== 'string' || !payload.api_key
    || typeof payload.api_base !== 'string' || !payload.api_base) return request
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  return new Request(request.url, { method: request.method, headers, signal: request.signal,
    body: JSON.stringify({ ...payload, model: 'openai/chat_completions/' + payload.model }) })
}
