const paths = new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/responses'])

/** Only the gateway's conversion routes, POST, with no query; anything else is null (404). */
export function converterRequest(request) {
  const url = new URL(request.url)
  if (request.method !== 'POST' || url.search || !paths.has(url.pathname)) return null
  return new Request('http://litellm' + url.pathname, request)
}
