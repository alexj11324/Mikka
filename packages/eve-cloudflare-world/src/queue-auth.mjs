const encoder = new TextEncoder()
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
const bytes = value => Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16))

export async function bodyDigest(body) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(body))) }

async function keyFor(secret, usage) {
  if (!/^[0-9a-f]{64}$/.test(secret ?? '')) throw new Error('Queue signing key unavailable')
  return crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

function canonical(revision, retries, timestamp, digest) {
  return encoder.encode(['mikka-eve-world-queue-v1', revision, retries, timestamp, digest].join('\n'))
}

export async function deliveryHeaders(secret, revision, retries, digest) {
  const timestamp = String(Date.now())
  const input = canonical(revision, retries, timestamp, digest)
  return {
    'content-type': 'application/json', 'x-mikka-eve-release': revision, 'CF-Queue-Retry-Count': String(retries),
    'x-mikka-queue-time': timestamp,
    'x-mikka-queue-signature': hex(await crypto.subtle.sign('HMAC', await keyFor(secret, 'sign'), input)),
  }
}

export async function authenticateDelivery(secret, revision, headers, body) {
  const timestamp = headers.get('x-mikka-queue-time')
  const retries = headers.get('CF-Queue-Retry-Count')
  const signature = headers.get('x-mikka-queue-signature')
  if (!/^\d{13}$/.test(timestamp ?? '') || Math.abs(Date.now() - Number(timestamp)) > 300_000 ||
      !/^\d{1,3}$/.test(retries ?? '') || !/^[0-9a-f]{64}$/.test(signature ?? '')) return false
  const input = canonical(revision, retries, timestamp, await bodyDigest(body))
  return crypto.subtle.verify('HMAC', await keyFor(secret, 'verify'), bytes(signature), input)
}
