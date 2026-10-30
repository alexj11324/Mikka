import { after } from 'next/server'
import { verifyGitHubSignature } from '@/lib/suggestions/github-webhook'
import { githubWebhookNotifications } from '@/lib/suggestions/sources'
import { ingestNotifications } from '@/lib/suggestions/store'
import { ciWakeup, recordCiWakeup } from '@/lib/github/ci/ingress'
import { pool } from '@/lib/db'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 1_000_000
const noStore = { 'Cache-Control': 'no-store' }

/** GitHub webhook for the suggestions list: review requests, assignments, and replies on the person's PRs and issues. */
export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) return new Response('Webhook is not configured.', { status: 503, headers: noStore })
  const event = request.headers.get('x-github-event')
  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) return new Response('Webhook payload is too large.', { status: 413, headers: noStore })
  if (!verifyGitHubSignature(rawBody, request.headers.get('x-hub-signature-256'), secret)) return new Response('Invalid webhook.', { status: 401, headers: noStore })
  if (!event || event === 'ping') return new Response(null, { status: 204, headers: noStore })
  let payload: Record<string, unknown>
  try { payload = JSON.parse(rawBody) } catch { return new Response('Invalid webhook JSON.', { status: 400, headers: noStore }) }
  // The same endpoint still handles PR, issue, comment and review business
  // events. GitHub must separately stop sending workflow_run at cutover.
  const wakeup = process.env.MIKKA_CI_EXTERNAL_POLLING === '1' ? null : ciWakeup(event, payload)
  let ciScheduled = false
  if (wakeup) {
    try { ciScheduled = await recordCiWakeup(pool, wakeup) }
    catch { return new Response('CI event could not be saved.', { status: 503, headers: noStore }) }
  }
  after(async () => {
    if (ciScheduled) {
      try {
        const { reconcileCi } = await import('@/lib/github/ci/reconcile')
        await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })
      } catch { console.error('GitHub CI reconciliation failed') }
    }
    try { await ingestNotifications(await githubWebhookNotifications(event, payload)) }
    catch (error) { console.error('GitHub suggestion ingest failed', error instanceof Error ? error.message : error) }
  })
  return new Response(null, { status: 202, headers: noStore })
}
