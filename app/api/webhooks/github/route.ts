import { after } from 'next/server'
import { verifyGitHubSignature } from '@/lib/suggestions/github-webhook'
import { githubCandidateIds } from '@/lib/suggestions/notification'
import { noteLogOutcome, withRequestLog } from '@/lib/request-log'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 1_000_000
const noStore = { 'Cache-Control': 'no-store' }

/** GitHub webhook for the suggestions list: review requests, assignments, and replies on the person's PRs and issues. */
async function handlePOST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) return new Response('Webhook is not configured.', { status: 503, headers: noStore })
  const event = request.headers.get('x-github-event')
  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) return new Response('Webhook payload is too large.', { status: 413, headers: noStore })
  if (!verifyGitHubSignature(rawBody, request.headers.get('x-hub-signature-256'), secret)) return new Response('Invalid webhook.', { status: 401, headers: noStore })
  if (!event || event === 'ping') {
    noteLogOutcome('ignored')
    return new Response(null, { status: 204, headers: noStore })
  }
  let payload: Record<string, unknown>
  try { payload = JSON.parse(rawBody) } catch { return new Response('Invalid webhook JSON.', { status: 400, headers: noStore }) }
  const hasNotifications = payload !== null && githubCandidateIds(event, payload).length > 0
  if (event !== 'pull_request' && !hasNotifications) {
    noteLogOutcome('ignored')
    return new Response(null, { status: 204, headers: noStore })
  }
  after(async () => {
    if (event === 'pull_request') {
      try { await (await import('@/lib/github/publication-webhook')).refreshPublishedPullRequest(event, payload) }
      catch { console.error('GitHub delivery refresh failed') }
    }
    if (hasNotifications) {
      try {
        const notifications = await (await import('@/lib/suggestions/sources')).githubWebhookNotifications(event, payload)
        if (notifications.length) await (await import('@/lib/suggestions/store')).ingestNotifications(notifications)
      } catch (error) { console.error('GitHub suggestion ingest failed', error instanceof Error ? error.message : error) }
    }
  })
  noteLogOutcome('work')
  return new Response(null, { status: 202, headers: noStore })
}

export const POST = withRequestLog('/api/webhooks/github', handlePOST)
