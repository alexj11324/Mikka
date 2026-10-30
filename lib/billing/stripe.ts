// Minimal Stripe REST client for 计费 (V15): Checkout and Customer Portal
// redirects, and webhook signature checks. No SDK; tests pass their own fetch.
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface StripeConfig { secretKey: string; teamPriceId: string | null; webhookSecret: string | null }

/** Null when billing is not set up on this deployment (billingNotConfigured). */
export function stripeConfig(env: Readonly<Record<string, string | undefined>> = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim()
  if (!secretKey) return null
  return { secretKey, teamPriceId: env.STRIPE_TEAM_PRICE_ID?.trim() || null, webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null }
}

export class StripeRequestError extends Error {
  constructor(readonly status: number) { super(`stripe request failed (${status})`); this.name = 'StripeRequestError' }
}

/** Form-encodes nested params the way Stripe expects (a[b]=c, a[0][b]=c). */
export function stripeForm(params: Record<string, unknown>, prefix = ''): string[] {
  const pairs: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (Array.isArray(value)) value.forEach((item, i) => pairs.push(...(typeof item === 'object' && item ? stripeForm(item as Record<string, unknown>, `${name}[${i}]`) : [`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`])))
    else if (typeof value === 'object') pairs.push(...stripeForm(value as Record<string, unknown>, name))
    else pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
  }
  return pairs
}

/** POST to the Stripe API. Never logs the key or the response body. */
export async function stripePost<T>(config: StripeConfig, path: string, params: Record<string, unknown>, fetchImpl: typeof fetch = fetch, idempotencyKey?: string): Promise<T> {
  const response = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    body: stripeForm(params).join('&'),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new StripeRequestError(response.status)
  return response.json() as Promise<T>
}

/** Stripe-Signature check (t=…,v1=…; HMAC-SHA256 of `${t}.${body}`), within `toleranceSeconds`. */
export function verifyStripeSignature(body: string, header: string | null, secret: string, now = Date.now(), toleranceSeconds = 300): boolean {
  if (!header) return false
  const parts = header.split(',').map(part => part.split('=') as [string, string])
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1])
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest()
  return parts.some(([key, value]) => {
    if (key !== 'v1' || !/^[a-f0-9]{64}$/.test(value ?? '')) return false
    return timingSafeEqual(Buffer.from(value, 'hex'), expected)
  })
}
