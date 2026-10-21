import { z } from 'zod'
import { db } from '@/lib/db'
import { linearSyncInbox } from '@/lib/db/schema'
import { verifyLinearSignature } from '@/lib/linear-sync/crypto'
import { dispatchLinearWebhook } from '@/lib/linear-sync/dispatch'

export const runtime = 'nodejs'
const MAX_BODY_BYTES = 1_000_000
const payloadSchema = z.object({
  action: z.string().min(1).max(32),
  type: z.string().min(1).max(100),
  organizationId: z.string().min(1).max(128),
  webhookTimestamp: z.number().finite(),
  data: z.record(z.string(), z.unknown()),
}).passthrough()

async function readBody(request: Request) {
  const declaredSize = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) return null
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function POST(request: Request) {
  const secret = process.env.LINEAR_WEBHOOK_SECRET
  if (!secret) return Response.json({ error: 'Webhook is not configured' }, { status: 503 })
  const deliveryId = request.headers.get('linear-delivery')
  const eventHeader = request.headers.get('linear-event')
  const signature = request.headers.get('linear-signature')
  if (!deliveryId || deliveryId.length > 200 || !eventHeader || eventHeader.length > 100 || !signature) return Response.json({ error: 'Invalid Linear webhook headers' }, { status: 400 })
  const rawBody = await readBody(request)
  if (rawBody === null) return Response.json({ error: 'Webhook payload is too large' }, { status: 413 })
  if (!verifyLinearSignature(rawBody, signature, secret)) return Response.json({ error: 'Invalid Linear webhook signature' }, { status: 401 })
  let parsedBody: unknown
  try { parsedBody = JSON.parse(rawBody) } catch { return Response.json({ error: 'Invalid webhook JSON' }, { status: 400 }) }
  const parsed = payloadSchema.safeParse(parsedBody)
  if (!parsed.success || parsed.data.type !== eventHeader || Math.abs(Date.now() - parsed.data.webhookTimestamp) > 60_000) {
    return Response.json({ error: 'Invalid or expired Linear webhook' }, { status: 401 })
  }
  const supported = ['Issue', 'Comment', 'OAuthAuthorization', 'OAuthApp'].includes(parsed.data.type)
  if (!supported) return new Response(null, { status: 200 })
  const [saved] = await db.insert(linearSyncInbox).values({
    deliveryId,
    organizationId: parsed.data.organizationId,
    eventType: parsed.data.type,
    payload: parsed.data,
  }).onConflictDoNothing().returning({ deliveryId: linearSyncInbox.deliveryId })
  if (saved) dispatchLinearWebhook(saved.deliveryId)
  return new Response(null, { status: 200 })
}
