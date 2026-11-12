const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
export const GUEST_LEASE_MS = 300_000

export function reviewScope(value, now = Date.now()) {
  if (!value || ![value.leaseId, value.deviceId, value.repoId, value.sourceOperationId].every(s => typeof s === 'string' && uuid.test(s)) ||
      !hash.test(value.bindingId ?? '') || !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
      !['terminal', 'preview'].includes(value.kind) || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now || value.expiresAt > now + GUEST_LEASE_MS ||
      typeof value.worktreePath !== 'string' || value.worktreePath.length > 4096 ||
      !value.worktreePath.startsWith('/workspace/worktrees/') || Array.from(value.worktreePath).some(character => character.charCodeAt(0) < 32) ||
      value.worktreePath.split('/').slice(1).some(s => !s || s === '.' || s === '..')) throw Error('Invalid task review scope')
  const { leaseId, deviceId, repoId, sourceOperationId, bindingId, epoch, kind, expiresAt, worktreePath } = value
  return { leaseId, deviceId, repoId, sourceOperationId, bindingId, epoch, kind, expiresAt, worktreePath }
}

function encode(bytes) {
  let bits = 0, buffer = 0, out = ''
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) { bits -= 5; out += alphabet[(buffer >>> bits) & 31] }
  }
  return bits ? out + alphabet[(buffer << (5 - bits)) & 31] : out
}

export function previewAlias(instanceId) {
  if (!hash.test(instanceId)) throw Error('Invalid review instance')
  const data = new Uint8Array(39)
  data.set(Uint8Array.from(instanceId.match(/../g), s => Number.parseInt(s, 16)))
  crypto.getRandomValues(data.subarray(32))
  return encode(data)
}

export function aliasInstance(alias) {
  if (typeof alias !== 'string' || !/^[a-z2-7]{63}$/.test(alias)) return null
  const bytes = []
  let bits = 0, buffer = 0
  for (const c of alias) {
    buffer = (buffer << 5) | alphabet.indexOf(c)
    bits += 5
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255) }
  }
  if (encode(bytes) !== alias) return null
  return bytes.slice(0, 32).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function previewSuffix(env) {
  const suffix = env.TASK_PREVIEW_DOMAIN
  if (typeof suffix !== 'string' || suffix.length > 189 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(suffix)) return null
  return suffix
}

export async function guestControl(container, action, body) {
  const child = await container.exec(['/usr/bin/python3', '-I', '/opt/mikka/task-sandbox/review-control.py', action], {
    user: '0:0', stdin: new Response(JSON.stringify(body)).body,
  })
  const result = await child.output()
  if (result.exitCode !== 0 || result.stdout.byteLength > 16_384) throw Error('Task review control unavailable')
  return JSON.parse(new TextDecoder().decode(result.stdout))
}

export function previewRequest(request, origin) {
  const source = new URL(request.url)
  if (source.origin !== origin || source.username || source.password || source.port || source.hash || source.protocol !== 'https:')
    throw Error('Invalid preview request')
  const headers = new Headers()
  // Preserve the original gateway's Fetch Metadata, origin and service-worker
  // restrictions. Only its own partitioned session cookie can enter the guest.
  const forwarded = ['accept', 'accept-language', 'cache-control', 'content-type', 'origin', 'range', 'service-worker',
    'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-user', 'upgrade', 'sec-websocket-key',
    'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']
  for (const name of forwarded) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name))
  }
  if (headers.get('upgrade')?.toLowerCase() === 'websocket') headers.set('connection', 'Upgrade')
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(s => s.trim())
    .filter(s => /^__Host-mikka_preview=[A-Za-z0-9_-]{43}$/.test(s))
  if (cookies.length === 1) headers.set('cookie', cookies[0])
  headers.set('host', source.hostname)
  // The native port binding carries HTTP on Cloudflare's private connection.
  // The original HTTPS host and Origin headers still bind the guest's ticket.
  source.protocol = 'http:'
  return new Request(source, { method:request.method, headers, redirect:'manual',
    ...(['GET','HEAD'].includes(request.method) ? {} : { body:request.body, duplex:'half' }) })
}
