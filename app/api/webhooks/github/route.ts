import { after } from 'next/server'
import { verifyGitHubSignature } from '@/lib/suggestions/github-webhook'
import { githubWebhookNotifications } from '@/lib/suggestions/sources'
import { ingestNotifications } from '@/lib/suggestions/store'
import { factoryMerges } from '@/lib/factory/server'

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
  const merged = mergedPullRequest(event, payload)
  after(async () => {
    if (merged) {
      try { await factoryMerges.pullRequestMerged(merged) }
      catch (error) { console.error('Factory merge completion failed', error instanceof Error ? error.message : error) }
    }
    try { await ingestNotifications(await githubWebhookNotifications(event, payload)) }
    catch (error) { console.error('GitHub suggestion ingest failed', error instanceof Error ? error.message : error) }
  })
  return new Response(null, { status: 202, headers: noStore })
}
