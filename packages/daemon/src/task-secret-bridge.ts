import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { TaskSecretAccess } from '@mikka/protocol/task-secrets'
import { CodedError } from '@mikka/protocol/coded-error'

const MAX_BODY = 512 * 1024
const MAX_RESPONSE = 2 * 1024 * 1024
const FORWARD_HEADERS = new Set(['accept', 'content-type', 'idempotency-key', 'notion-version', 'stripe-version', 'x-api-version'])
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'])
export const TASK_SECRET_DUMMY_KEY = 'mikka-protected'

export interface TaskSecretBridge {
  env: Record<string, string>
  instructions: string
  close(): void
}

function localTarget(value: string) {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.hash &&
      (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
  } catch { return false }
}

function refuse(response: ServerResponse, detail: string, status = 403) {
  if (response.destroyed || response.headersSent) { response.destroy(); return }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ code: 'task_secret_unavailable', detail }))
}

async function readBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > limit) throw new CodedError('task_secret_unavailable', { detail: 'limit_exceeded' })
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}

/** Only dummy SDK authentication is accepted here. No caller header can replace
 * the trusted egress authentication, and no cookie or arbitrary host is sent. */
function requestHeaders(request: IncomingMessage): Array<[string, string]> | null {
  const seen = new Set<string>()
  const result: Array<[string, string]> = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index].toLowerCase()
    const value = request.rawHeaders[index + 1]
    if (seen.has(name)) return null
    seen.add(name)
    if (AUTH_HEADERS.has(name)) {
      if (value !== TASK_SECRET_DUMMY_KEY && value !== `Bearer ${TASK_SECRET_DUMMY_KEY}`) return null
    } else if (FORWARD_HEADERS.has(name)) result.push([name, value])
    else if (!['host', 'connection', 'content-length', 'transfer-encoding', 'user-agent', 'accept-encoding', 'accept-language', 'sec-fetch-mode'].includes(name)) return null
  }
  return result
}

/** SDK compatibility only. This process never receives an underlying protected
 * Secret. An Agent with host access can read/steal its short-lived capability,
 * but cannot turn it into a different owner, run, origin, operation or raw key. */
export async function startTaskSecretBridge(options: {
  current(): TaskSecretAccess | undefined
  signal: AbortSignal
  fetch?: typeof fetch
}): Promise<TaskSecretBridge | undefined> {
  const initial = options.current()
  if (!initial || (!initial.grants.length && !initial.unavailable.length)) return undefined
  if (!localTarget(initial.endpoint)) throw new CodedError('task_secret_unavailable', { detail: 'configuration' })
  options.signal.throwIfAborted()
  const nonce = randomBytes(24).toString('hex')
  const pending = new Set<AbortController>()
  let closed = false
  let authority = ''
  const requestFetch = options.fetch ?? fetch
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => refuse(response, 'invalid_request', 400))
  })
  server.maxHeadersCount = 32
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.on('clientError', (_error, socket) => socket.destroy())

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (closed || options.signal.aborted) return refuse(response, 'expired_capability', 410)
    // Reject browser-originated requests and DNS rebinding even on loopback.
    if (request.headers.origin || request.headers.host !== authority || request.headers['sec-fetch-site']) return refuse(response, 'invalid_request')
    const raw = request.url ?? ''
    const prefix = `/${nonce}/`
    if (!raw.startsWith(prefix)) return refuse(response, 'invalid_request', 404)
    const tail = raw.slice(prefix.length)
    const boundary = tail.search(/[/?]/)
    const name = boundary < 0 ? tail : tail.slice(0, boundary)
    const path = boundary < 0 ? '/' : tail[boundary] === '?' ? `/${tail.slice(boundary)}` : tail.slice(boundary)
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || path.length > 4_000) return refuse(response, 'invalid_request', 400)
    const current = options.current()
    const grant = current?.grants.find(candidate => candidate.name === name)
    if (!grant) return refuse(response, 'configuration', 409)
    if (Date.parse(grant.expiresAt) <= Date.now()) return refuse(response, 'expired_capability', 410)
    if (!current || current.endpoint !== initial!.endpoint) return refuse(response, 'invalid_request')
    const headers = requestHeaders(request)
    if (!headers) return refuse(response, 'invalid_request')
    const method = request.method ?? 'GET'
    const body = await readBody(request, MAX_BODY)
    const controller = new AbortController()
    pending.add(controller)
    const disconnected = () => { if (!response.writableEnded) controller.abort() }
    response.once('close', disconnected)
    try {
      const upstream = await requestFetch(current.endpoint, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability: grant.capability, method, path, headers,
          ...(body.length ? { bodyBase64: body.toString('base64') } : {}) }),
        signal: AbortSignal.any([options.signal, controller.signal, AbortSignal.timeout(25_000)]),
      })
      if (!upstream.ok) {
        await upstream.body?.cancel()
        return refuse(response, upstream.status === 401 || upstream.status === 410 ? 'expired_capability' : 'invalid_request', upstream.status === 401 || upstream.status === 410 ? 410 : 502)
      }
      const reader = upstream.body?.getReader()
      if (!reader) return refuse(response, 'response_blocked', 502)
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          bytes += item.value.length
          if (bytes > MAX_RESPONSE * 2) { await reader.cancel(); return refuse(response, 'response_blocked', 502) }
          chunks.push(item.value)
        }
      } finally { reader.releaseLock() }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!result || typeof result !== 'object') return refuse(response, 'response_blocked', 502)
      const value = result as { status?: unknown; headers?: unknown; bodyBase64?: unknown }
      if (!Number.isInteger(value.status) || (value.status as number) < 200 || (value.status as number) >= 600 ||
        typeof value.bodyBase64 !== 'string' || value.bodyBase64.length > Math.ceil(MAX_RESPONSE / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64)) return refuse(response, 'response_blocked', 502)
      if (closed || options.signal.aborted || Date.parse(grant.expiresAt) <= Date.now()) return refuse(response, 'expired_capability', 410)
      const safeHeaders: Record<string, string> = { 'cache-control': 'no-store' }
      if (value.headers && typeof value.headers === 'object') for (const [key, header] of Object.entries(value.headers)) {
        if (['content-type', 'retry-after'].includes(key) && typeof header === 'string' && !/[\r\n]/.test(header)) safeHeaders[key] = header
      }
      response.writeHead(value.status as number, safeHeaders)
      response.end(Buffer.from(value.bodyBase64, 'base64'))
    } catch {
      // Fetch errors may contain URLs/headers. Only this closed reason crosses
      // the Agent-facing boundary; no exception text is logged or uploaded.
      refuse(response, 'upstream_unavailable', 502)
    } finally {
      pending.delete(controller)
      response.off('close', disconnected)
    }
  }

  const close = () => {
    closed = true
    options.signal.removeEventListener('abort', close)
    for (const controller of pending) controller.abort()
    server.closeAllConnections()
    server.close()
  }
  options.signal.addEventListener('abort', close, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { server.off('error', failed); options.signal.removeEventListener('abort', cancelled) }
      const failed = (cause: Error) => { cleanup(); reject(cause) }
      const cancelled = () => { cleanup(); reject(new CodedError('task_secret_unavailable', { detail: 'expired_capability' })) }
      server.once('error', failed)
      options.signal.addEventListener('abort', cancelled, { once: true })
      if (options.signal.aborted) { cancelled(); return }
      server.listen(0, '127.0.0.1', () => { cleanup(); resolve() })
    })
    options.signal.throwIfAborted()
  } catch (cause) { close(); throw new CodedError('task_secret_unavailable', { detail: 'configuration', cause }) }
  const address = server.address()
  if (!address || typeof address === 'string') { close(); throw new CodedError('task_secret_unavailable', { detail: 'configuration' }) }
  authority = `127.0.0.1:${address.port}`
  const endpoints = Object.fromEntries(initial.grants.map(grant => [grant.name, `http://${authority}/${nonce}/${grant.name}`]))
  return {
    close,
    env: { MIKKA_SECRET_ENDPOINTS: JSON.stringify(endpoints),
      ...(initial.unavailable.length ? { MIKKA_SECRET_UNAVAILABLE: JSON.stringify(initial.unavailable) } : {}) },
    instructions: [
      'Third-party Secret delivery: protected values are absent from the environment. Read MIKKA_SECRET_ENDPOINTS for per-secret HTTP base URLs; use the SDK key "mikka-protected" and the approved API path. Native model and GitHub credentials use their normal paths.',
      ...(initial.unavailable.length ? [`These Secrets need an owner-configured HTTP policy or explicit direct-exposure compatibility before use: ${initial.unavailable.join(', ')}. Report this configuration requirement instead of guessing a key or changing delivery policy.`] : []),
    ].join('\n'),
  }
}
