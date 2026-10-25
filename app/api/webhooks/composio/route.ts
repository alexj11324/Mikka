import { after } from 'next/server'
import { verifyComposioWebhook } from '@/lib/composio-webhook'
import { composioNotification } from '@/lib/suggestions/notification'
import { ingestNotifications } from '@/lib/suggestions/store'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const apiKey = process.env.COMPOSIO_API_KEY
  const verifySecret = process.env.COMPOSIO_WEBHOOK_SECRET
  if (!apiKey || !verifySecret) return new Response('Webhook is not configured.', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  let verified: Awaited<ReturnType<typeof verifyComposioWebhook>>
  try {
    verified = await verifyComposioWebhook(request, apiKey, verifySecret)
  } catch {
    return new Response('Invalid webhook.', { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
  // Trigger events from Gmail, Slack and Notion become suggestions; anything else is acknowledged.
  const notification = verified.payload.userId ? composioNotification(verified.payload) : null
  if (notification) {
    after(async () => {
      try { await ingestNotifications([notification]) }
      catch (error) { console.error('Composio suggestion ingest failed', error instanceof Error ? error.message : error) }
    })
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
