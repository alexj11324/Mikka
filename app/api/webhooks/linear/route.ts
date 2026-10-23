import { withRequestLog } from '@/lib/request-log'
import { db } from '@/lib/db'
import { linearSyncInbox } from '@/lib/db/schema'
import { dispatchLinearWebhook } from '@/lib/linear-sync/dispatch'
import { parseLinearWebhookRequest } from '@/lib/linear-sync/webhook'

export const runtime = 'nodejs'

async function handlePOST(request: Request) {
  const parsed = await parseLinearWebhookRequest(request, process.env.LINEAR_WEBHOOK_SECRET)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  if ('ignored' in parsed) return new Response(null, { status: 200 })
  const [saved] = await db.insert(linearSyncInbox).values({
    deliveryId: parsed.deliveryId,
    organizationId: parsed.organizationId,
    eventType: parsed.eventType,
    payload: parsed.payload,
  }).onConflictDoNothing().returning({ deliveryId: linearSyncInbox.deliveryId })
  if (saved) dispatchLinearWebhook(saved.deliveryId)
  return new Response(null, { status: 200 })
}

export const POST = withRequestLog('/api/webhooks/linear', handlePOST)
