import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { allowedApiPath, normalizedRendererPath, RENDERER_CSP, RENDERER_ORIGIN, rendererAssetPath } from './bundled-policy'
import type { BundledAuth } from './bundled-auth'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
}
const REQUEST_HEADERS = new Set(['accept', 'content-type', 'range', 'if-none-match', 'if-modified-since', 'x-mikka-stream-key'])
const RESPONSE_HEADERS = new Set(['content-type', 'content-disposition', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'x-mikka-stream-key', 'retry-after'])
const MAX_UPLOAD = 32 * 1024 * 1024

function localHeaders(type?: string): Headers {
  return new Headers({ 'content-security-policy': RENDERER_CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(type ? { 'content-type': type } : {}) })
}
function failure(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: localHeaders('application/json') })
}

export async function boundedRequestBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return undefined
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_UPLOAD) throw new Error('upload_too_large')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_UPLOAD) { await reader.cancel(); throw new Error('upload_too_large') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result.buffer
}

/** Streaming response bodies remain streaming. Only known request/response headers
 * cross the boundary; cookies, auth, redirects and remote policy headers do not. */
export function bundledProtocol(root: string, auth: Pick<BundledAuth, 'request'>): (request: Request) => Promise<Response> {
  return async request => {
    let url: URL
    try { url = new URL(request.url) } catch { return failure(400, 'invalid_url') }
    if (`${url.protocol}//${url.host}` !== RENDERER_ORIGIN || url.username || url.password) return failure(403, 'untrusted_origin')
    const path = normalizedRendererPath(url.pathname)
    if (path === null) return failure(400, 'invalid_path')
    if (path.startsWith('/api/')) {
      const origin = request.headers.get('origin')
      // Sandboxed artifact frames have an opaque origin, so cannot act as the app.
      if ((origin && origin !== RENDERER_ORIGIN) || !allowedApiPath(path, request.method)) return failure(403, 'desktop_route_denied')
      try {
        const headers = new Headers()
        request.headers.forEach((value, key) => { if (REQUEST_HEADERS.has(key)) headers.set(key, value) })
        const body = await boundedRequestBody(request)
        const response = await auth.request(`${path}${url.search}`, { method: request.method, headers, body, signal: request.signal })
        if (response.status >= 300 && response.status < 400 && response.status !== 304) return failure(502, 'desktop_redirect_denied')
        const output = localHeaders()
        response.headers.forEach((value, key) => { if (RESPONSE_HEADERS.has(key)) output.set(key, value) })
        if (response.headers.get('content-type')?.includes('text/html')) {
          // Artifact HTML is an opaque sandbox, even if opened as a top-level page.
          output.set('content-security-policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors mikka://app")
        }
        return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers: output })
      } catch (error) { return failure(error instanceof Error && error.message === 'upload_too_large' ? 413 : 503, 'desktop_backend_unavailable') }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405, 'method_not_allowed')
    let pathOnDisk = rendererAssetPath(root, url.pathname)
    if (!pathOnDisk) return failure(404, 'not_found')
    // SPA routes use the same locally shipped entry; missing assets never become HTML.
    if (!extname(pathOnDisk) && !path.startsWith('/assets/')) pathOnDisk = join(root, 'index.html')
    try {
      const actualRoot = await realpath(root)
      const actual = await realpath(pathOnDisk)
      if (actual !== actualRoot && !actual.startsWith(`${actualRoot}${sep}`)) return failure(403, 'invalid_path')
      const info = await stat(actual)
      if (!info.isFile()) return failure(404, 'not_found')
      const headers = localHeaders(TYPES[extname(actual)] ?? 'application/octet-stream')
      headers.set('content-length', String(info.size))
      if (path.startsWith('/assets/')) headers.set('cache-control', 'public, max-age=31536000, immutable')
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(await readFile(actual)), { headers })
    } catch { return failure(404, 'not_found') }
  }
}
