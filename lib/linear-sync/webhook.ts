import { z } from 'zod'

const MAX_BODY_BYTES = 1_000_000
const payloadSchema = z.object({
  action: z.string().min(1).max(32),
  type: z.string().min(1).max(100),
  organizationId: z.string().min(1).max(128),
  webhookTimestamp: z.number().finite(),
  data: z.record(z.string(), z.unknown()),
}).passthrough()

const encoder = new TextEncoder()

export async function verifyLinearSignature(rawBody: string, signature: string, secret: string) {
  if (!/^[a-f\d]{64}$/i.test(signature) || !secret) return false
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const signatureBytes = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16))
  return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(rawBody))
}

export async function verifyBearer(value: string | null, secret: string) {
  const match = value?.match(/^Bearer (.+)$/)
  if (!match || !secret) return false
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const [actual, expected] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(match[1]!)),
    crypto.subtle.sign('HMAC', key, encoder.encode(secret)),
  ])
  const actualBytes = new Uint8Array(actual)
  const expectedBytes = new Uint8Array(expected)
  let difference = 0
  for (let index = 0; index < expectedBytes.length; index++) difference |= actualBytes[index]! ^ expectedBytes[index]!
  return difference === 0
}

type LinearWebhookPayload = z.infer<typeof payloadSchema>

export function isLinearOAuthRevocation(event: { type?: unknown; action?: unknown }) {
  return (event.type === 'OAuthAuthorization' || event.type === 'OAuthApp') &&
    typeof event.action === 'string' && ['remove', 'revoke', 'revoked'].includes(event.action)
}
type ParseResult =
  | { ok: true; ignored: true }
  | { ok: true; deliveryId: string; eventType: string; organizationId: string; payload: LinearWebhookPayload }
  | { ok: false; status: number; error: string }

export async function parseLinearWebhookRequest(request: Request, secret: string | undefined): Promise<ParseResult> {
  if (!secret) return { ok: false, status: 503, error: 'Webhook is not configured' }
  const deliveryId = request.headers.get('linear-delivery')
  const eventHeader = request.headers.get('linear-event')
  const signature = request.headers.get('linear-signature')
  if (!deliveryId || deliveryId.length > 200 || !eventHeader || eventHeader.length > 100 || !signature) {
    return { ok: false, status: 400, error: 'Invalid Linear webhook headers' }
  }
  const declaredSize = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Webhook payload is too large' }
  }
  const reader = request.body?.getReader()
  if (!reader) return { ok: false, status: 400, error: 'Invalid webhook JSON' }
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      return { ok: false, status: 413, error: 'Webhook payload is too large' }
    }
    chunks.push(decoder.decode(value, { stream: true }))
  }
  chunks.push(decoder.decode())
  const rawBody = chunks.join('')
  if (!await verifyLinearSignature(rawBody, signature, secret)) {
    return { ok: false, status: 401, error: 'Invalid Linear webhook signature' }
  }
  let body: unknown
  try { body = JSON.parse(rawBody) }
  catch { return { ok: false, status: 400, error: 'Invalid webhook JSON' } }
  const parsed = payloadSchema.safeParse(body)
  if (!parsed.success || parsed.data.type !== eventHeader || Math.abs(Date.now() - parsed.data.webhookTimestamp) > 60_000) {
    return { ok: false, status: 401, error: 'Invalid or expired Linear webhook' }
  }
  if (!['Issue', 'Comment', 'OAuthAuthorization', 'OAuthApp'].includes(parsed.data.type)) return { ok: true, ignored: true }
  return {
    ok: true,
    deliveryId,
    eventType: parsed.data.type,
    organizationId: parsed.data.organizationId,
    payload: parsed.data,
  }
}
