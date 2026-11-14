import { timingSafeEqual } from 'node:crypto'

const encoder = new TextEncoder()
const headers = { 'cache-control': 'no-store' }

/** True when `value` is exactly `Bearer <secret>`, comparing fixed-size HMACs in constant time. */
export async function verifyBearer(value: string | null, secret: string) {
  const match = value?.match(/^Bearer (.+)$/)
  if (!match || !secret) return false
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const [actual, expected] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(match[1]!)),
    crypto.subtle.sign('HMAC', key, encoder.encode(secret)),
  ])
  return timingSafeEqual(actual, expected)
}

/**
 * The guard every /api/cron route runs first: 503 when CRON_SECRET is unset, 401 unless the request
 * carries `Bearer <CRON_SECRET>`, both uncached. null means the caller is the cron Worker.
 */
export async function cronUnauthorized(request: Request): Promise<Response | null> {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503, headers })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401, headers })
  return null
}
