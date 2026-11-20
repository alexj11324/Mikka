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
