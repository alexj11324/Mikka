import { withRequestLog } from '@/lib/request-log'
import { after } from 'next/server'
import { db } from '@/lib/db'
import { linearSyncInbox } from '@/lib/db/schema'
import { dispatchLinearWebhook } from '@/lib/linear-sync/dispatch'
import { parseLinearWebhookRequest } from '@/lib/linear-sync/webhook'
import { linearWebhookNotifications } from '@/lib/suggestions/sources'
import { ingestNotifications } from '@/lib/suggestions/store'
import { linearSyncDisabledResponse, linearSyncEnabled, linearSyncState } from '@/lib/linear-sync/flags'

export const runtime = 'nodejs'

async function handlePOST(request: Request) {
  const parsed = await parseLinearWebhookRequest(request, process.env.LINEAR_WEBHOOK_SECRET)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  if ('ignored' in parsed) return new Response(null, { status: 200 })
  const state = await linearSyncState()
  if (state === 'disabled') return Response.json({ disabled: true })
  if (state !== 'enabled') return linearSyncDisabledResponse()
  const [saved] = await db.insert(linearSyncInbox).values({
    deliveryId: parsed.deliveryId,
    organizationId: parsed.organizationId,
    eventType: parsed.eventType,
    payload: parsed.payload,
  }).onConflictDoNothing().returning({ deliveryId: linearSyncInbox.deliveryId })
  if (saved) {
    dispatchLinearWebhook(saved.deliveryId)
    // The same delivery feeds the suggestions list; only a first delivery, so a retry is not judged twice.
    after(async () => {
      if (!await linearSyncEnabled()) return
      try { await ingestNotifications(await linearWebhookNotifications(parsed.organizationId, parsed.payload)) }
      catch (error) { console.error('Linear suggestion ingest failed', error instanceof Error ? error.message : error) }
    })
  }
  return new Response(null, { status: 200 })
}

export const POST = withRequestLog('/api/webhooks/linear', handlePOST)
