import { after } from 'next/server'
import { verifyGitHubSignature } from '@/lib/suggestions/github-webhook'
import { githubWebhookNotifications } from '@/lib/suggestions/sources'
import { ingestNotifications } from '@/lib/suggestions/store'
import { ciResumeEnabled } from '@/lib/github/ci/flag'

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
  const ciScheduled = ciResumeEnabled() ? await recordCiResult(event, payload) : false
  after(async () => {
    try { await ingestNotifications(await githubWebhookNotifications(event, payload)) }
    catch (error) { console.error('GitHub suggestion ingest failed', error instanceof Error ? error.message : error) }
    // After the suggestion ingest, so a slow GitHub read never delays it.
    if (ciScheduled) {
      try {
        const [{ pool }, { reconcileCi }] = await Promise.all([import('@/lib/db'), import('@/lib/github/ci/reconcile')])
        await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })
      } catch { console.error('GitHub CI reconciliation failed') }
    }
  })
  return new Response(null, { status: 202, headers: noStore })
}

/** CI-result sub-handler, behind MIKKA_CI_RESUME_ENABLED. Like the suggestion
 * ingest it is isolated: a failure is logged by name only and never changes the
 * response for the other handlers. A lost wakeup is still caught by the 15-minute
 * cron reconcile while the watch is open (docs/github-ci-subscriptions.md). */
async function recordCiResult(event: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const { ciWakeup, recordCiWakeup } = await import('@/lib/github/ci/ingress')
    const wakeup = ciWakeup(event, payload)
    if (!wakeup) return false
    const { pool } = await import('@/lib/db')
    return await recordCiWakeup(pool, wakeup)
  } catch (error) {
    console.error('GitHub CI result could not be recorded', error instanceof Error ? error.name : typeof error)
    return false
  }
}
