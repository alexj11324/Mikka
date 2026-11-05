import { afterJob } from '@/lib/background'
import { verifyGitHubSignature } from '@/lib/suggestions/github-webhook'
import { githubCandidateIds } from '@/lib/suggestions/notification'
import { PULL_REQUEST_REFRESH_ACTIONS } from '@/lib/github/publication-webhook-actions'
import { noteLogOutcome, withRequestLog } from '@/lib/request-log'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 1_000_000
const noStore = { 'Cache-Control': 'no-store' }

/** Merged PR, from a verified delivery: completes the Factory tasks waiting on it (#528), including merges made on GitHub. */
function mergedPullRequest(event: string, payload: Record<string, unknown>) {
  if (event !== 'pull_request' || payload.action !== 'closed') return null
  const pr = payload.pull_request as { html_url?: unknown; merged?: unknown; merge_commit_sha?: unknown; head?: { sha?: unknown } } | undefined
  if (pr?.merged !== true || typeof pr.html_url !== 'string') return null
  return { url: pr.html_url, headSha: typeof pr.head?.sha === 'string' ? pr.head.sha : null, mergeCommitSha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null }
}

/** GitHub webhook for the suggestions list (review requests, assignments, and replies on the person's PRs and issues) and Factory merges. */
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
  const hasNotifications = payload !== null && typeof payload === 'object' && githubCandidateIds(event, payload).length > 0
  // Only actions that can change a delivered PR's stored state or badge refresh it (#1212); the rest of
  // pull_request (labels, reviewers, assignees…) and every other event without a notification stop here.
  const refresh = event === 'pull_request' && typeof payload?.action === 'string' && PULL_REQUEST_REFRESH_ACTIONS.has(payload.action)
  const merged = mergedPullRequest(event, payload)
  if (!refresh && !merged && !hasNotifications) {
    noteLogOutcome('ignored')
    return new Response(null, { status: 204, headers: noStore })
  }
  afterJob('after:github-webhook', async () => {
    // The delivery's own state first: a merge then finds it already marked, and its task views refresh once.
    if (refresh) {
      try { await (await import('@/lib/github/publication-webhook')).refreshPublishedPullRequest(event, payload) }
      catch { console.error('GitHub delivery refresh failed') }
    }
    if (merged) {
      try { await (await import('@/lib/factory/server')).factoryMerges.pullRequestMerged(merged) }
      catch (error) { console.error('Factory merge completion failed', error instanceof Error ? error.message : error) }
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
