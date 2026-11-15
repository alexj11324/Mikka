import { readGitHubWebhookBody } from '@/lib/github/webhook-dispatch'
import { validSlackSignature } from './webhook'

const MAX_BYTES = 1_000_000
const noStore = { 'Cache-Control': 'no-store' }

/**
 * Slack events for 自动化 Slack triggers (decision 2026-11-15-2010), forwarded by Eve's Slack channel with Slack's own
 * body and signature headers. The signature is checked here again with the same signing secret, and the event must be
 * this app's; nothing else is trusted. 200 once queued (or nothing matched); 503 when the automations could not be queued.
 */
export async function handleSlackAutomations(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  const secret = env.SLACK_SIGNING_SECRET, app = env.SLACK_APP_ID
  if (!secret || !app) return Response.json({ error: 'Slack is not configured' }, { status: 503, headers: noStore })
  const raw = await readGitHubWebhookBody(request, MAX_BYTES)
  if (raw === null) return Response.json({ error: 'Payload too large' }, { status: 413, headers: noStore })
  if (!validSlackSignature(raw, request.headers.get('x-slack-request-timestamp'), request.headers.get('x-slack-signature'), secret)) {
    return Response.json({ error: 'Invalid signature' }, { status: 401, headers: noStore })
  }
  let payload: unknown
  try { payload = JSON.parse(raw) } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: noStore }) }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload as { api_app_id?: unknown }).api_app_id !== app) {
    return Response.json({ queued: 0 }, { headers: noStore })
  }
  const { fireSlackAutomations } = await import('@/lib/schedules/runtime')
  try { return Response.json({ queued: await fireSlackAutomations(payload as Record<string, unknown>) }, { headers: noStore }) }
  catch { return Response.json({ error: 'Could not queue automations' }, { status: 503, headers: noStore }) }
}
