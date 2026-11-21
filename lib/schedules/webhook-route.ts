import { readGitHubWebhookBody } from '@/lib/github/webhook-dispatch'
import { ScheduleError } from './contract'
import { WEBHOOK_KEY, WEBHOOK_MAX_BYTES, webhookBody, webhookRequestKey } from './webhook'

const noStore = { 'Cache-Control': 'no-store' }

/**
 * An automation's webhook URL (decision 2026-11-15-1830). The key in the path is the only credential; the body (up to
 * 64 KB of text) reaches the Bot as data. 202 when it is queued, batched, a repeat of a request ID, or skipped by the
 * automation's limits; 404 for an unknown or switched-off URL; 409 while the automation is paused.
 */
export async function handleAutomationWebhook(request: Request, key: string): Promise<Response> {
  if (!WEBHOOK_KEY.test(key)) return Response.json({ error: 'scheduleNotFound' }, { status: 404, headers: noStore })
  const raw = await readGitHubWebhookBody(request, WEBHOOK_MAX_BYTES)
  if (raw === null) return Response.json({ error: 'webhookPayloadTooLarge' }, { status: 413, headers: noStore })
  if (raw.includes('�')) return Response.json({ error: 'webhookPayloadNotText' }, { status: 415, headers: noStore })
  const { receiveAutomationWebhook } = await import('./runtime')
  try {
    return Response.json(await receiveAutomationWebhook(key, webhookBody(raw), webhookRequestKey(request.headers)), { status: 202, headers: noStore })
  } catch (error) {
    if (error instanceof ScheduleError && (error.status === 404 || error.status === 409)) return Response.json({ error: error.code }, { status: error.status, headers: noStore })
    throw error
  }
}
