import { withRequestLog } from '@/lib/request-log'
import { verifyComposioWebhook } from '@/lib/composio-webhook'

export const runtime = 'nodejs'

async function handlePOST(request: Request) {
  const apiKey = process.env.COMPOSIO_API_KEY
  const verifySecret = process.env.COMPOSIO_WEBHOOK_SECRET
  if (!apiKey || !verifySecret) return new Response('Webhook is not configured.', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  try {
    await verifyComposioWebhook(request, apiKey, verifySecret)
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return new Response('Invalid webhook.', { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
}

export const POST = withRequestLog('/api/webhooks/composio', handlePOST)
