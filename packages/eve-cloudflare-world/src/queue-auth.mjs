const encoder = new TextEncoder()
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
const bytes = value => Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16))
const b64bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0))

export async function bodyDigest(body) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(body))) }

async function keyFor(material, usage) {
  const prefix = usage === 'sign' ? 'ed25519-pkcs8:' : 'ed25519-public:'
  if (typeof material === 'string' && material.startsWith(prefix)) {
    return crypto.subtle.importKey(usage === 'sign' ? 'pkcs8' : 'raw', b64bytes(material.slice(prefix.length)), 'Ed25519', false, [usage])
  }
  if (!/^[0-9a-f]{64}$/.test(material ?? '')) throw new Error('Queue authentication key unavailable')
  return crypto.subtle.importKey('raw', bytes(material), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

function canonical(revision, retries, timestamp, digest) {
  return encoder.encode(['mikka-eve-world-queue-v1', revision, retries, timestamp, digest].join('\n'))
}

export async function deliveryHeaders(material, revision, retries, digest) {
  const timestamp = String(Date.now())
  const key = await keyFor(material, 'sign')
  const signature = await crypto.subtle.sign(key.algorithm.name, key, canonical(revision, retries, timestamp, digest))
  return {
    'content-type': 'application/json', 'x-mikka-eve-release': revision, 'CF-Queue-Retry-Count': String(retries),
    'x-mikka-queue-time': timestamp, 'x-mikka-queue-signature': hex(signature),
  }
}

export async function authenticateDelivery(material, revision, headers, body) {
  const timestamp = headers.get('x-mikka-queue-time')
  const retries = headers.get('CF-Queue-Retry-Count')
  const signature = headers.get('x-mikka-queue-signature')
  if (!/^\d{13}$/.test(timestamp ?? '') || Math.abs(Date.now() - Number(timestamp)) > 300_000 ||
      !/^\d{1,3}$/.test(retries ?? '') || !/^(?:[0-9a-f]{64}|[0-9a-f]{128})$/.test(signature ?? '')) return false
  const key = await keyFor(material, 'verify')
  const input = canonical(revision, retries, timestamp, await bodyDigest(body))
  return crypto.subtle.verify(key.algorithm.name, key, bytes(signature), input)
}
