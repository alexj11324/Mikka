import { verifyComposioWebhook } from '@/lib/composio-webhook'

export const runtime = 'nodejs'

export async function POST(request: Request) {
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
