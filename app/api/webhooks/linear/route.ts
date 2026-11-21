import { withRequestLog } from '@/lib/request-log'
import { afterJob } from '@/lib/background'
import { db } from '@/lib/db'
import { linearSyncInbox } from '@/lib/db/schema'
import { dispatchLinearWebhook } from '@/lib/linear-sync/dispatch'
import { isLinearOAuthRevocation, parseLinearWebhookRequest } from '@/lib/linear-sync/webhook'
import { processLinearOAuthRevocation } from '@/lib/linear-sync/oauth-revocation'
import { linearWebhookNotifications } from '@/lib/suggestions/sources'
import { ingestNotifications } from '@/lib/suggestions/store'
import { linearSyncDisabledResponse, linearSyncEnabled, linearSyncState } from '@/lib/linear-sync/flags'


async function handlePOST(request: Request) {
  const parsed = await parseLinearWebhookRequest(request, process.env.LINEAR_WEBHOOK_SECRET)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  if ('ignored' in parsed) return new Response(null, { status: 200 })
  // 自动化 Linear triggers (decision 2026-11-15-1930) are not sync: they run whether sync is on or off, before the ACK,
  // so a failure is a 503 and Linear redelivers; the delivery ID makes a redelivery add nothing.
  const { fireLinearAutomations } = await import('@/lib/schedules/runtime')
  try { await fireLinearAutomations(parsed.deliveryId, parsed.payload) }
  catch { return Response.json({ error: 'Could not queue automations' }, { status: 503 }) }
  const state = await linearSyncState()
  if (state === 'disabled') {
    if (!isLinearOAuthRevocation(parsed.payload)) return Response.json({ disabled: true })
    try {
      await processLinearOAuthRevocation(parsed.payload)
      return new Response(null, { status: 200 })
    } catch {
      return linearSyncDisabledResponse()
    }
  }
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
    afterJob('after:linear-webhook-suggestions', async () => {
      if (!await linearSyncEnabled()) return
      try { await ingestNotifications(await linearWebhookNotifications(parsed.organizationId, parsed.payload)) }
      catch (error) { console.error('Linear suggestion ingest failed', error instanceof Error ? error.message : error) }
    })
  }
  return new Response(null, { status: 200 })
}

export const POST = withRequestLog('/api/webhooks/linear', handlePOST)
