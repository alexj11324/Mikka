import { withRequestLog } from '@/lib/request-log'
import { getTelegramBot, isTelegramConfigured } from '@/lib/telegram/bot'
import { after } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handlePOST(request: Request) {
  if (!isTelegramConfigured()) return new Response('Telegram webhook is not configured', { status: 503 })
  try {
    return await getTelegramBot().webhooks.telegram(request, { waitUntil: task => after(() => task) })
  } catch (error) {
    console.error('Telegram webhook processing failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    return new Response('Telegram webhook processing failed', { status: 500 })
  }
}

export const POST = withRequestLog('/api/webhooks/telegram', handlePOST)
