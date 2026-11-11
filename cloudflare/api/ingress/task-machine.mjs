import { timingSafeEqual } from 'node:crypto'
import { handleTaskProcessSocket } from '../../task-sandbox/process-socket.mjs'

const HOST = 'task-machine.internal'
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_METADATA_BYTES = 16 * 1024
const writes = new Set(['/v1/open', '/v1/park', '/v1/status', '/v1/read-file', '/v1/write-file', '/v1/remove-path'])

const refused = (code, status) => Response.json({ error: code }, { status, headers: { 'cache-control': 'no-store' } })

export function configureTaskBridge(container, ctx) {
  // Each shared API instance gets its own capability. A DO restart may reconnect
  // to a still-running Node process, so retain the capability with that DO.
  let token = ctx.storage.kv.get('task-machine.bridge-token')
  if (!token) {
    token = crypto.randomUUID() + crypto.randomUUID()
    ctx.storage.kv.put('task-machine.bridge-token', token)
  }
  container.envVars.MIKKA_TASK_MACHINE_BRIDGE_TOKEN = token
  ctx.blockConcurrencyWhile(() => container.setOutboundByHost(HOST, 'taskMachine', { token }))
}

async function boundedJson(request, limit) {
  if (!request.body || Number(request.headers.get('content-length')) > limit) throw new RangeError()
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0, json = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) { await reader.cancel(); throw new RangeError() }
      json += decoder.decode(value, { stream: true })
    }
    return JSON.parse(json + decoder.decode())
  } finally { reader.releaseLock() }
}

function machineFailure(error) {
  switch (error?.message) {
    case 'Invalid task machine grant': return refused('invalid_grant', 400)
    case 'Task machine scope mismatch':
    case 'Task machine run mismatch': return refused('machine_not_found', 404)
    case 'Task machine lease expired': return refused('lease_expired', 410)
    case 'Task machine run already settled':
    case 'Task machine already has a writer':
    case 'Task machine interrupted':
    case 'Task machine is not running': return refused('machine_unavailable', 409)
    case 'Product task machine capacity exhausted': return refused('capacity', 429)
    default: return refused('machine_unavailable', 503)
  }
}

export async function taskMachine(request, env, { params }) {
  const url = new URL(request.url)
  const processSocket = url.pathname === '/v1/process'
  if (url.origin !== 'http://' + HOST || url.username || url.password || url.search || url.hash || (!processSocket && !writes.has(url.pathname))) return refused('not_found', 404)
  const token = params?.token
  const header = request.headers.get('authorization') ?? ''
  const expected = 'Bearer ' + token
  if (!token || header.length !== expected.length || !/^[ !-~]+$/.test(header)
      || !timingSafeEqual(new TextEncoder().encode(header), new TextEncoder().encode(expected))) return refused('forbidden', 403)
  if (!env.TASK_MACHINE) return refused('machine_unavailable', 503)
  if (processSocket) {
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return refused('invalid_request', 400)
    // The RPC handshake needs only an Upgrade. Never carry the container capability or cookies into the session.
    return handleTaskProcessSocket(new Request(url, { headers: { upgrade: 'websocket' } }), env.TASK_MACHINE)
  }
  if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return refused('invalid_request', 400)
  const write = url.pathname === '/v1/write-file'
  let body, bytes
  try {
    body = await boundedJson(request, MAX_METADATA_BYTES + (write ? Math.ceil(MAX_FILE_BYTES / 3) * 4 : 0))
    if (!body || typeof body.grant !== 'object' || !body.grant) return refused('invalid_grant', 400)
    if (url.pathname.endsWith('-file') || url.pathname === '/v1/remove-path') {
      if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.length > 4096) return refused('invalid_path', 400)
    }
    if (write) {
      if (typeof body.base64 !== 'string' || body.base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new RangeError()
      bytes = Uint8Array.from(atob(body.base64), char => char.charCodeAt(0))
      if (bytes.byteLength > MAX_FILE_BYTES) throw new RangeError()
    }
  } catch (error) { return refused('invalid_body', error instanceof RangeError ? 413 : 400) }
  const machine = env.TASK_MACHINE
  try {
    // Only negotiated RPC arguments cross the binding; discard all HTTP headers.
    switch (url.pathname) {
      case '/v1/open': return Response.json(await machine.open(body.grant))
      case '/v1/park': return Response.json(await machine.park(body.grant))
      case '/v1/status': return Response.json(await machine.status(body.grant))
      case '/v1/read-file': {
        const file = await machine.readFile(body.grant, body.path)
        return file == null ? new Response(null, { status: 204 }) : new Response(file, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } })
      }
      case '/v1/write-file': return Response.json(await machine.writeFile(body.grant, body.path, bytes))
      case '/v1/remove-path': {
        if (typeof body.force !== 'boolean' || typeof body.recursive !== 'boolean') return refused('invalid_options', 400)
        return Response.json((await machine.removePath(body.grant, body.path, { force: body.force, recursive: body.recursive })) ?? null)
      }
    }
  } catch (error) { return machineFailure(error) }
}
