import { afterJob } from '@/lib/background'
import { githubCandidateIds } from '@/lib/suggestions/notification'
import { PULL_REQUEST_REFRESH_ACTIONS, reviewRefreshEvent } from './publication-webhook-actions'
import { noteLogOutcome } from '@/lib/request-log'
import { reviewCheckEvent } from './review-checks'
import { completedCiSuite } from './ci-suite-event'
import { createHash } from 'node:crypto'

export const GITHUB_WEBHOOK_MAX_BYTES = 1_000_000
const noStore = { 'Cache-Control': 'no-store' }

export async function readGitHubWebhookBody(request: Request, limit = GITHUB_WEBHOOK_MAX_BYTES): Promise<string | null> {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null
  if (!request.body) return ''
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break
      length += next.value.byteLength
      if (length > limit) { await reader.cancel(); return null }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

/** Signature verification is the caller's boundary. Official and self-hosted
 * deployments each run this in their own runtime and Workflow environment.
 * Forwarded deliveries await the existing work before acknowledging, so a retry can recover a crash. */
export async function dispatchVerifiedGitHubWebhook(event: string | null, rawBody: string, options: { defer?: boolean; deliveryId?: string | null } = {}): Promise<Response> {
  if (!event || event === 'ping') { noteLogOutcome('ignored'); return new Response(null, { status: 204, headers: noStore }) }
  let payload: Record<string, unknown>
  try { payload = JSON.parse(rawBody) } catch { return new Response('Invalid webhook JSON.', { status: 400, headers: noStore }) }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return new Response('Invalid webhook JSON.', { status: 400, headers: noStore })
  // 自动化 event triggers (decision 2026-11-15-1704): runs are queued before GitHub is acknowledged, keyed by the
  // delivery, so a failure here answers 503 and the redelivery adds no second run.
  const { githubAutomationEvents } = await import('@/lib/schedules/github-events')
  const automationEvents = githubAutomationEvents(event, payload).length > 0
  if (automationEvents) {
    const deliveryKey = options.deliveryId && /^[A-Za-z0-9-]{1,100}$/.test(options.deliveryId) ? `github:${options.deliveryId}` : `github-body:${createHash('sha256').update(event).update('\0').update(rawBody).digest('hex')}`
    try { await (await import('@/lib/schedules/runtime')).fireGitHubAutomations(deliveryKey, event, payload) }
    catch (error) {
      console.error(JSON.stringify({ event: 'github_automation_fire_failed', causeName: error instanceof Error ? error.name : 'unknown' }))
      return new Response('Automations temporarily unavailable.', { status: 503, headers: noStore })
    }
  }
  const suite = completedCiSuite(event, payload)
  const hasNotifications = githubCandidateIds(event, payload).length > 0
  const refresh = (event === 'pull_request' && typeof payload.action === 'string' && PULL_REQUEST_REFRESH_ACTIONS.has(payload.action)) || Boolean(reviewCheckEvent(event, payload))
  const review = reviewRefreshEvent(event, payload.action)
  const pr = payload.pull_request as { html_url?: unknown; merged?: unknown; merge_commit_sha?: unknown; head?: { sha?: unknown } } | undefined
  const merged = event === 'pull_request' && payload.action === 'closed' && pr?.merged === true && typeof pr.html_url === 'string'
    ? { url: pr.html_url, headSha: typeof pr.head?.sha === 'string' ? pr.head.sha : null, mergeCommitSha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null } : null
  if (!suite && !refresh && !review && !merged && !hasNotifications) { noteLogOutcome(automationEvents ? 'work' : 'ignored'); return new Response(null, { status: automationEvents ? 202 : 204, headers: noStore }) }
  // A suite is a durable resume hint. Persist it before acknowledging GitHub:
  // afterJob work is best-effort and cannot be the only owner of this event.
  // Redelivery is safe through the Coordinator event outbox dedupe key.
  if (suite) await (await import('./ci-suite-wake')).wakeLinkedCiSuite(suite)
  const work = async () => {
    if (refresh) await (await import('./publication-webhook')).refreshPublishedPullRequest(event, payload)
    if (review) await (await import('./publication-webhook')).invalidatePublishedPullReview(payload)
    if (merged) await (await import('@/lib/factory/server')).factoryMerges.pullRequestMerged(merged)
    if (hasNotifications) {
      const notifications = await (await import('@/lib/suggestions/sources')).githubWebhookNotifications(event, payload)
      if (notifications.length) await (await import('@/lib/suggestions/store')).ingestNotifications(notifications)
    }
  }
  // A suite-only delivery already persisted its wake. It has no other work
  // and should not allocate an empty after-response job.
  if (options.defer && (refresh || review || merged || hasNotifications)) afterJob('after:github-webhook', async () => {
    try { await work() }
    catch (error) { console.error(JSON.stringify({ event: 'github_webhook_dispatch_failed', causeName: error instanceof Error ? error.name : 'unknown' })) }
  })
  else if (!options.defer) await work()
  noteLogOutcome('work')
  return new Response(null, { status: 202, headers: noStore })
}
