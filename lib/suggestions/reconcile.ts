import 'server-only'
import { and, eq, gte, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { linearSyncInbox, suggestions, suggestionTriggerChecks } from '@/lib/db/schema'
import { getComposio, runComposioAction } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import { redeliverFailedGitHubWebhooks, type RedeliveryResult } from './github-redelivery'
import { gmailNotification, notionSearchNotification, type ExternalNotification } from './notification'
import { ensureComposioTriggers, linearWebhookNotifications } from './sources'
import { ingestNotifications } from './store'

// The hourly backfill behind the webhooks (app/api/cron/suggestions-reconcile).
// It reads what each source holds now and ingests it like a webhook delivery;
// ingestNotifications skips anything already stored under the same external
// id, so only what a lost delivery missed is judged and added. GitHub is not
// re-read: Mikka's GitHub App asks GitHub to send its failed webhook
// deliveries again (./github-redelivery).

/** How far back the backfill looks. Longer than its interval, so one missed run is still covered. */
export const RECONCILE_WINDOW_MS = 26 * 60 * 60 * 1000
// Slack is left out: it is moving off Composio to Mikka's own Slack app.
const COMPOSIO_TOOLKITS = ['gmail', 'notion'] as const
const PEOPLE_CONCURRENCY = 4
const LINEAR_INBOX_LIMIT = 500

type Json = Record<string, unknown>
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : []

/** The same mail the Gmail trigger delivers, minus what Gmail files as promotions or social. */
async function recentGmail(userId: string): Promise<ExternalNotification[]> {
  const result = await runComposioAction(userId, 'fetch_recent_gmail', { query: 'in:inbox newer_than:2d -category:promotions -category:social', max_results: 50 })
  if ('error' in result) throw new Error(result.error)
  return list(result.data.messages).flatMap(message => ((notification => notification ? { ...notification, connectedAccountId: result.accountId } : [])(gmailNotification(userId, message))))
}

/**
 * Pages edited in the window. A page already on file under any edit time is
 * skipped: the trigger's edit time may be written differently from search's,
 * and a duplicate would show twice.
 */
async function recentNotion(userId: string, since: Date): Promise<ExternalNotification[]> {
  const result = await runComposioAction(userId, 'list_recent_notion_pages', { page_size: 25 })
  if ('error' in result) throw new Error(result.error)
  const pages = list(result.data.results).flatMap(page => notionSearchNotification(userId, page) ?? []).filter(page => page.occurredAt >= since)
  if (!pages.length) return []
  const known = await db.select({ externalId: suggestions.externalId }).from(suggestions)
    .where(and(eq(suggestions.userId, userId), eq(suggestions.source, 'notion'), gte(suggestions.createdAt, new Date(since.getTime() - RECONCILE_WINDOW_MS))))
  const pageId = (externalId: string) => externalId.split(':')[0]
  const knownPages = new Set(known.map(row => pageId(row.externalId)))
  return pages.filter(page => !knownPages.has(pageId(page.externalId)))
}

export interface ReconcileResult { people: number; read: Record<string, number>; failed: Record<string, number>; deferred: number; linear: { deliveries: number; notifications: number }; github: RedeliveryResult | null }

async function reconcilePerson(userId: string, toolkits: readonly string[], since: Date, result: ReconcileResult) {
  // A lost subscription is the likeliest reason deliveries stopped; re-create it (at most hourly).
  await ensureComposioTriggers(userId).catch((error: unknown) => console.error('Composio trigger check failed', error instanceof Error ? error.message : error))
  const readers: Record<string, () => Promise<ExternalNotification[]>> = {
    gmail: () => recentGmail(userId),
    notion: () => recentNotion(userId, since),
  }
  for (const toolkit of toolkits) {
    try {
      const notifications = await readers[toolkit]()
      await ingestNotifications(notifications)
      result.read[toolkit] = (result.read[toolkit] ?? 0) + notifications.length
    } catch (error) {
      result.failed[toolkit] = (result.failed[toolkit] ?? 0) + 1
      console.error(`Suggestions backfill could not read ${toolkit}`, error instanceof Error ? error.message : error)
    }
  }
}

/**
 * Linear deliveries are stored in linear_sync_inbox before they are
 * acknowledged, whichever host received them, so the backfill replays the
 * window's Issue and Comment deliveries from there instead of asking Linear.
 */
async function reconcileLinear(since: Date, result: ReconcileResult) {
  const deliveries = await db.select({ organizationId: linearSyncInbox.organizationId, payload: linearSyncInbox.payload }).from(linearSyncInbox)
    .where(and(gte(linearSyncInbox.receivedAt, since), inArray(linearSyncInbox.eventType, ['Issue', 'Comment'])))
    .limit(LINEAR_INBOX_LIMIT)
  for (const delivery of deliveries) {
    const notifications = await linearWebhookNotifications(delivery.organizationId, delivery.payload)
    await ingestNotifications(notifications)
    result.linear.notifications += notifications.length
  }
  result.linear.deliveries = deliveries.length
}

/**
 * Backfills the window for everyone who uses the suggestions list (has opened
 * it or connected an app through Composio). Stops starting new people after
 * `deadline`; they are covered by the next run while still in the window.
 */
export async function reconcileSuggestions({ now = new Date(), deadline = Infinity }: { now?: Date; deadline?: number } = {}): Promise<ReconcileResult> {
  const since = new Date(now.getTime() - RECONCILE_WINDOW_MS)
  const result: ReconcileResult = { people: 0, read: {}, failed: {}, deferred: 0, linear: { deliveries: 0, notifications: 0 }, github: null }
  try { result.github = await redeliverFailedGitHubWebhooks({ now }) }
  catch (error) {
    result.failed.github = 1
    console.error('Suggestions backfill could not redeliver GitHub webhooks', error instanceof Error ? error.message : error)
  }
  try { await reconcileLinear(since, result) }
  catch (error) {
    result.failed.linear = 1
    console.error('Suggestions backfill could not replay Linear deliveries', error instanceof Error ? error.message : error)
  }
  const composio = getComposio()
  if (!composio) return result
  // Least recently checked first, so a run cut short by the deadline moves on to others next time.
  const people = (await db.select({ userId: suggestionTriggerChecks.userId }).from(suggestionTriggerChecks).orderBy(suggestionTriggerChecks.checkedAt)).map(row => row.userId)
  for (let index = 0; index < people.length; index += PEOPLE_CONCURRENCY) {
    if (Date.now() > deadline) { result.deferred = people.length - index; break }
    await Promise.all(people.slice(index, index + PEOPLE_CONCURRENCY).map(async userId => {
      try {
        const accounts = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: [...COMPOSIO_TOOLKITS], statuses: ['ACTIVE'], cursor }))
        const toolkits = [...new Set(accounts.filter(account => account.status === 'ACTIVE' && !account.isDisabled).map(account => account.toolkit.slug.toLowerCase()))]
          .filter(toolkit => (COMPOSIO_TOOLKITS as readonly string[]).includes(toolkit))
        result.people++
        if (toolkits.length) await reconcilePerson(userId, toolkits, since, result)
      } catch (error) {
        result.failed.composio = (result.failed.composio ?? 0) + 1
        console.error('Suggestions backfill could not list connected apps', error instanceof Error ? error.message : error)
      }
    }))
  }
  return result
}
