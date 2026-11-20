import { Readable } from 'node:stream'

// Provider substitutes bind only to loopback. Request journals stay in memory;
// credential headers are never copied into them or written to logs.
export const json = (response, value, status = 200, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(value))
  return true
}

export async function bodyBytes(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16 * 1024 * 1024) throw new Error('Fake provider request too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function bodyJson(request) {
  const bytes = await bodyBytes(request)
  return bytes.length ? JSON.parse(bytes.toString()) : {}
}

export function requestRecord(request, url, body) {
  return { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(['content-type', 'accept', 'x-github-api-version', 'e2b-sandbox-id']
      .filter(name => request.headers[name] !== undefined).map(name => [name, request.headers[name]])),
    ...(body === undefined ? {} : { body }) }
}

export function incomingRequest(request, url) {
  return new Request(url, { method: request.method, headers: request.headers,
    ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Readable.toWeb(request), duplex: 'half' }) })
}

export function assertLoopbackOrigin(origin) {
  const url = new URL(origin)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('Fake providers require an HTTP loopback origin')
  return url.origin
}
