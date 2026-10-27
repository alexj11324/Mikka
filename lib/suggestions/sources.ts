import 'server-only'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { linearConnections, linearIssueLinks, suggestionTriggerChecks } from '@/lib/db/schema'
import { getComposio, runComposioAction } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import { linearGraphQL } from '@/lib/linear-sync/graphql'
import { linearAccessToken } from '@/lib/linear-sync/tokens'
import { githubCandidateIds, githubNotification, gmailNotification, linearCommentNotification, linearIssueNotification, type ExternalNotification } from './notification'
import { ingestNotifications, recordTimeZone, writeFirstBriefing } from './store'
import { missingTriggers, TRIGGER_CHECK_INTERVAL_MS, TRIGGER_PATTERNS, triggerSlugs } from './triggers'

// Where notifications come from. Linear and GitHub webhooks carry full
// payloads; Gmail, Slack and Notion arrive as Composio trigger events, which Composio
// polls for us. Right after the person connects an app, its current data is
// read once so the first briefing has something in it.

/** Notifications for everyone a Linear webhook concerns. */
export async function linearWebhookNotifications(organizationId: string, payload: Record<string, unknown>): Promise<ExternalNotification[]> {
  if (payload.type === 'Issue') {
    const recipients = await db.select({ userId: linearConnections.userId, linearUserId: linearConnections.linearUserId }).from(linearConnections)
      .where(and(eq(linearConnections.organizationId, organizationId), isNull(linearConnections.revokedAt)))
    return recipients.flatMap(recipient => linearIssueNotification(recipient, payload) ?? [])
  }
  if (payload.type === 'Comment') {
    const issueId = (payload.data as Record<string, unknown> | undefined)?.issueId
    if (typeof issueId !== 'string') return []
    // The person who owns the synced issue in Mikka hears about comments on it.
    const recipients = await db.select({ userId: linearConnections.userId, linearUserId: linearConnections.linearUserId }).from(linearIssueLinks)
      .innerJoin(linearConnections, eq(linearConnections.userId, linearIssueLinks.ownerId))
      .where(and(eq(linearIssueLinks.linearIssueId, issueId), eq(linearConnections.organizationId, organizationId), isNull(linearConnections.revokedAt)))
    return recipients.flatMap(recipient => linearCommentNotification(recipient, payload) ?? [])
  }
  return []
}

/** Notifications for every Mikka person a GitHub event is about, matched by their GitHub sign-in. */
export async function githubWebhookNotifications(event: string, payload: Record<string, unknown>): Promise<ExternalNotification[]> {
  const ids = githubCandidateIds(event, payload)
  if (!ids.length) return []
  const { rows } = await pool.query<{ userId: string; accountId: string }>('select "userId", "accountId" from account where "providerId" = $1 and "accountId" = any($2)', ['github', ids])
  return rows.flatMap(row => githubNotification({ userId: row.userId, githubId: row.accountId }, event, payload) ?? [])
}

/**
 * Makes sure each of the person's active Gmail, Slack and Notion accounts has
 * its Composio triggers, creating only the missing ones, so it is safe to run
 * again. Unless `force`, it runs at most once per TRIGGER_CHECK_INTERVAL_MS.
 * Returns the toolkits the person has connected.
 */
export async function ensureComposioTriggers(userId: string, { force = false } = {}): Promise<string[]> {
  const composio = getComposio()
  if (!composio) return []
  const now = new Date()
  if (!force) {
    // Claim the check first, so concurrent reads do not all call Composio.
    const claimed = await db.insert(suggestionTriggerChecks).values({ userId, checkedAt: now })
      .onConflictDoUpdate({ target: suggestionTriggerChecks.userId, set: { checkedAt: now }, setWhere: lt(suggestionTriggerChecks.checkedAt, new Date(now.getTime() - TRIGGER_CHECK_INTERVAL_MS)) })
      .returning({ userId: suggestionTriggerChecks.userId })
    if (!claimed.length) return []
  } else {
    await db.insert(suggestionTriggerChecks).values({ userId, checkedAt: now }).onConflictDoUpdate({ target: suggestionTriggerChecks.userId, set: { checkedAt: now } })
  }
  const accounts = (await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], statuses: ['ACTIVE'], cursor })))
    .filter(account => account.status === 'ACTIVE' && !account.isDisabled)
  const toolkits = [...new Set(accounts.map(account => account.toolkit.slug))]
  const watched = toolkits.filter(toolkit => TRIGGER_PATTERNS[toolkit])
  if (!watched.length) return toolkits
  const [catalog, active] = await Promise.all([
    listComposioPages(cursor => composio.triggers.listTypes({ toolkits: watched, cursor })),
    listComposioPages(cursor => composio.triggers.listActive({ connectedAccountIds: accounts.map(account => account.id), cursor })),
  ])
  const wanted = accounts.flatMap(account => triggerSlugs(account.toolkit.slug, catalog.filter(type => type.toolkit.slug.toLowerCase() === account.toolkit.slug.toLowerCase())).map(slug => ({ connectedAccountId: account.id, slug })))
  for (const { connectedAccountId, slug } of missingTriggers(wanted, active)) {
    try {
      await composio.triggers.create(userId, slug, { connectedAccountId })
    } catch (error) {
      console.error('Composio trigger subscription failed', { trigger: slug, error: error instanceof Error ? error.name : 'unknown' })
    }
  }
  return toolkits
}

/** Important mail from the last two days, as Gmail sees it now. */
async function currentGmail(userId: string): Promise<ExternalNotification[]> {
  const result = await runComposioAction(userId, 'fetch_recent_gmail', { query: 'in:inbox is:important newer_than:2d -category:promotions -category:social', max_results: 15 })
  if ('error' in result) return []
  const messages = (result.data as { messages?: unknown }).messages
  return Array.isArray(messages) ? messages.flatMap(message => gmailNotification(userId, message as Record<string, unknown>) ?? []) : []
}

/** Open Linear issues assigned to the person that moved in the last three days. */
async function currentLinear(userId: string): Promise<ExternalNotification[]> {
  type Wire = { viewer: { assignedIssues: { nodes: { id: string; identifier: string; title: string; url: string; updatedAt: string; description: string | null }[] } } }
  const data = await linearGraphQL<Wire>(await linearAccessToken(userId), `query MikkaFirstBriefing {
    viewer { assignedIssues(first: 20, orderBy: updatedAt, filter: { updatedAt: { gt: "-P3D" }, state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { id identifier title url updatedAt description }
    } }
  }`)
  return data.viewer.assignedIssues.nodes.map(issue => ({
    userId, source: 'linear', externalId: `issue:${issue.id}:assigned`, action: 'handle', title: issue.title, url: issue.url, actor: null,
    occurredAt: new Date(issue.updatedAt), required: true, direct: true, fromSelf: false, automated: false,
    excerpt: `${issue.identifier} ${issue.title}\n${issue.description ?? ''}`.slice(0, 2000),
  }))
}

/**
 * Runs right after the person connects an app: subscribes its triggers, reads
 * what is there now, judges it like any webhook, and writes the first
 * briefing, which the Coordinator then delivers in its chat. Never throws; a source that fails just adds nothing.
 */
export async function bootstrapSuggestions(userId: string, app: 'composio' | 'linear', timeZone: string | null) {
  const read = async <T,>(label: string, load: () => Promise<T[]>): Promise<T[]> => {
    try { return await load() } catch (error) {
      console.error(`First briefing could not read ${label}`, error instanceof Error ? error.message : error)
      return []
    }
  }
  try {
    // The callbacks only know the IP-derived zone; it fills a gap until the browser reports one.
    await recordTimeZone(userId, timeZone, { replace: false }).catch((error: unknown) => console.error('Time zone could not be saved', error instanceof Error ? error.message : error))
    const notifications = app === 'linear'
      ? await read('Linear', () => currentLinear(userId))
      : (await read('Composio', () => ensureComposioTriggers(userId, { force: true }))).includes('gmail') ? await read('Gmail', () => currentGmail(userId)) : []
    await ingestNotifications(notifications)
    // Loaded here so the webhook routes that import this module do not pull in the Coordinator workflow.
    if (await writeFirstBriefing(userId, timeZone)) await (await import('@/lib/coordinator/wake')).wakeCoordinator(userId)
  } catch (error) {
    console.error('First briefing failed', error instanceof Error ? error.message : error)
  }
}
