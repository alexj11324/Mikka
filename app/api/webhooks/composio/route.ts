import { getComposio } from '@/lib/composio'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const verifySecret = process.env.COMPOSIO_WEBHOOK_SECRET
  const composio = getComposio()
  if (!verifySecret || !composio) return new Response('Webhook is not configured.', { status: 503 })
  try {
    await composio.triggers.parse(request, { verifySecret })
    return new Response(null, { status: 204 })
  } catch {
    return new Response('Invalid webhook.', { status: 401 })
  }
}
