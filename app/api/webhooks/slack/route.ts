import { after } from 'next/server'
import { getSlackBot } from '@/lib/slack/bot'
import { slackConfig, slackOwner } from '@/lib/slack/config'
import { validSlackSignature } from '@/lib/slack/webhook'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request) {
  const config = slackConfig(process.env)
  if (!config) return new Response('Slack is not configured', { status: 503 })
  const body = await request.clone().text()
  if (!validSlackSignature(body, request.headers.get('x-slack-request-timestamp'), request.headers.get('x-slack-signature'), config.SLACK_SIGNING_SECRET)) {
    return new Response('Invalid signature', { status: 401 })
  }
  let payload: unknown
  try { payload = JSON.parse(body) } catch { return new Response('Invalid JSON', { status: 400 }) }
  if (payload && typeof payload === 'object' && 'type' in payload && payload.type === 'url_verification' && 'challenge' in payload && typeof payload.challenge === 'string') {
    // Slack must verify the endpoint without a model call or DB connection.
    return Response.json({ challenge: payload.challenge })
  }
  if (!slackOwner(config, payload)) return new Response(null, { status: 204 })
  return getSlackBot().webhooks.slack(request, {
    waitUntil: task => after(() => task),
    propagateHandlerErrors: true,
  })
}
