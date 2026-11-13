import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import fill, { handlePrivateFill } from './dist/fill.js'
import probe from './dist/oidc.js'

const privateHeaders = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'content-type': 'application/json' }

export function createBrokerServer() {
  const server = createServer({ maxHeaderSize: 24_576, requestTimeout: 60_000 }, async (request, response) => {
    if ((request.method === 'GET' || request.method === 'HEAD') && request.url === '/health.json') {
      response.writeHead(200, privateHeaders).end(request.method === 'HEAD' ? undefined : '{"ok":true}')
      return
    }
    // Each compiled handler owns its own identity check, body limit and lease
    // verification. Match the literal private route; never derive an upstream.
    const handler = request.url === '/api/fill' ? (process.env.CREDENTIAL_RUNTIME === 'cloudflare' ? handlePrivateFill : fill)
      : request.url === '/api/oidc' && process.env.CREDENTIAL_RUNTIME !== 'cloudflare' ? probe : null
    if (!handler) { response.writeHead(404, privateHeaders).end(); return }
    try { await handler(request, response) }
    catch {
      // Handler exceptions may contain credential material. A partial response
      // must terminate rather than becoming a second JSON message.
      if (response.headersSent) response.destroy()
      else response.writeHead(503, privateHeaders).end('{"error":"credential_unavailable"}')
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createBrokerServer()
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0')
  process.once('SIGTERM', () => server.close())
}
