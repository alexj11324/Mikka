import 'server-only'
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { continuedLevel } from '@/lib/attention/judgment'
import { scoreNotification } from '@/lib/attention/score'
import { judgmentContext, matterContext, recordNotice } from '@/lib/attention/store'
import { briefingEvent } from '@/lib/coordinator-events'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { db } from '@/lib/db'
import { extractFacts } from '@/lib/profile/extract'
import { briefings, suggestions, userPreferences, users, userTimeZones } from '@/lib/db/schema'
import { displayTitle, type ActionTitleInput } from './action-title'
import { writeActionTitles } from './action-title-server'
import { BRIEFING_HOUR, BRIEFING_WINDOW_MS, briefingCandidates, briefingContent, briefingHighlightInput, briefingHighlightQuestions, dueBriefingZones, readBriefingHighlights, type BriefingItem, localClock, localDate, localInstant, safeTimeZone } from './briefing'
import type { ExternalNotification } from './notification'
import { keepEnabledSources } from './source-settings'

/** How far back the list reaches; older suggestions drop off. */
const LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const LIST_LIMIT = 100

/**
 * Rates each new notification once with the attention model (R-20) and
 * stores it; repeats are skipped before any model call. Every level but low
 * shows in 建议. Critical, high and ask go on their matter, which the person's
 * Coordinator is handed (lib/attention/store.ts); a later notice on a matter
 * the person has not answered never rates below it. Each stored item is then
 * read once for facts about the person (lib/profile). `route: false` does not
 * hand anything over, for what was already there when an app was connected.
 * Notifications from a Composio app the person turned off as a source are dropped first.
 */
export async function ingestNotifications(incoming: readonly ExternalNotification[], { route = true } = {}) {
  const woken = new Set<string>()
  const actionItems = new Map<string, ActionTitleInput[]>()
  // Apps the person turned off as a source in Settings are not read at all.
  const notifications = await keepEnabledSources(incoming)
  await Promise.all(notifications.map(async notification => {
    const [seen] = await db.select({ id: suggestions.id }).from(suggestions)
      .where(and(eq(suggestions.userId, notification.userId), eq(suggestions.source, notification.source), eq(suggestions.externalId, notification.externalId))).limit(1)
    if (seen) return
    const now = new Date()
    const { same, matters, ids } = await judgmentContext(notification.userId, notification.matterKey, now)
    const score = await scoreNotification(notification, matters, same, now)
    const continuesId = score.continues ? ids.get(score.continues) ?? null : null
    const earlier = same ?? (continuesId ? await matterContext(notification.userId, continuesId) : null)
    const level = continuedLevel(score.level, earlier)
    const id = randomUUID()
    // A suggestion is the person's Coordinator's: its bot row is stored now, so sending it later resolves nothing.
    // Notifications come from the account's app connections and name no workspace: the personal workspace's Coordinator.
    const { botId } = await (await import('@/lib/coordinator/coordinator-bot')).coordinatorBot(notification.userId, null)
    const [stored] = await db.insert(suggestions).values({
      id, userId: notification.userId, botId, source: notification.source, externalId: notification.externalId, matterKey: notification.matterKey,
      action: notification.action, title: notification.title, url: notification.url, actor: notification.actor,
      shown: level !== 'low', decidedBy: score.decidedBy, level, required: notification.required,
      occurredAt: notification.occurredAt,
    }).onConflictDoNothing().returning({ id: suggestions.id })
    if (stored && level !== 'low') actionItems.set(notification.userId, [...actionItems.get(notification.userId) ?? [], { id, source: notification.source, action: notification.action, title: notification.title, actor: notification.actor, excerpt: notification.excerpt }])
    if (stored && route && await recordNotice(notification, id, { ...score, level }, continuesId)) woken.add(notification.userId)
    // R-73: what the item says about the person, low ones included (receipts are usually low).
    if (stored) await extractFacts(notification, id)
  }))
  // One batched call per person writes the shown items as actions (R-45).
  await Promise.all([...actionItems].map(([userId, items]) => writeActionTitles(userId, items)))
  // The Coordinator's wake hands the next waiting matter over, one at a time.
  // Loaded here so the webhook routes that import this module do not pull in the Coordinator workflow.
  if (woken.size) {
    const { wakeCoordinator } = await import('@/lib/coordinator/wake')
    for (const userId of woken) await wakeCoordinator(userId)
  }
}

const visible = (userId: string, since: Date) => and(eq(suggestions.userId, userId), eq(suggestions.shown, true), isNull(suggestions.dismissedAt), gte(suggestions.createdAt, since))

/** What the person sees: shown, not dismissed, from the last week, newest first. */
export async function listSuggestions(userId: string) {
  return db.select().from(suggestions).where(visible(userId, new Date(Date.now() - LIST_WINDOW_MS))).orderBy(desc(suggestions.occurredAt)).limit(LIST_LIMIT)
}

/** Atomically claim a visible suggestion for sending inside the caller's transaction. */
export async function claimSuggestion(userId: string, id: string, executor: Pick<typeof db, 'update'>) {
  const [row] = await executor.update(suggestions).set({ dismissedAt: new Date() })
    .where(and(eq(suggestions.id, id), eq(suggestions.userId, userId), eq(suggestions.shown, true), isNull(suggestions.dismissedAt)))
    .returning()
  return row ?? null
}

/** Read only an owned, shown suggestion, including one already dismissed. */
export async function readClaimedSuggestion(userId: string, id: string, executor: Pick<typeof db, 'select'>) {
  const [row] = await executor.select().from(suggestions).where(and(eq(suggestions.id, id), eq(suggestions.userId, userId), eq(suggestions.shown, true))).limit(1)
  return row ?? null
}

/** Takes a suggestion off the person's list. False when it is not theirs. */
export async function dismissSuggestion(userId: string, id: string, executor: Pick<typeof db, 'update'> = db) {
  const rows = await executor.update(suggestions).set({ dismissedAt: new Date() }).where(and(eq(suggestions.id, id), eq(suggestions.userId, userId), isNull(suggestions.dismissedAt))).returning({ id: suggestions.id })
  return rows.length > 0
}

async function briefingRow(userId: string, timeZone: string, kind: 'first' | 'daily', now: Date) {
  const items = await db.select().from(suggestions).where(visible(userId, new Date(now.getTime() - BRIEFING_WINDOW_MS)))
  return { userId, localDate: localDate(timeZone, now), kind, timeZone, ...briefingContent(items, await pickHighlights(userId, items)) }
}

/** The items the briefing names, picked by the Decisions API; none when it gives no answer (the counts still go out). */
async function pickHighlights(userId: string, items: readonly BriefingItem[]): Promise<string[]> {
  const candidates = briefingCandidates(items)
  if (!candidates.length) return []
  const [{ decide }, { hostedBillingScope }, { executionWorkspace }] = await Promise.all([import('@/lib/coordinator/decide'), import('@/lib/abuse/context'), import('@/lib/execution-settings')])
  try {
    const answers = await hostedBillingScope.run({ workspaceId: await executionWorkspace(userId, null), ownerId: userId }, () => decide('briefing-highlights', briefingHighlightInput(candidates), briefingHighlightQuestions(candidates)))
    return readBriefingHighlights(answers, candidates)
  } catch { return [] }
}

type Briefing = typeof briefings.$inferSelect

/** A daily briefing with nothing in it only records that the day was checked; the person sees no briefing. */
const shown = (row: Briefing | undefined) => row && !(row.kind === 'daily' && !row.total) ? row : null

/** True when the row still has to give way to today's daily briefing: none yet, or one written on connecting before it came due. */
const pending = (row: Briefing | undefined, dueAt: Date) => !row || (row.kind === 'first' && row.createdAt < dueAt)

/**
 * Hands a briefing with something in it to the Coordinator, which writes it to
 * the person in its chat (R-21). The event's dedupe key keeps it to one push
 * per briefing kind and local date. True when there was something to push;
 * the caller then wakes the Coordinator.
 */
async function pushBriefing(row: Briefing): Promise<boolean> {
  if (!row.total) return false
  const items = (await briefingHighlights(row.userId, row.highlights)).map(item => ({ suggestionId: item.id, source: item.source, action: item.action, title: displayTitle(item), actor: item.actor, url: item.url, required: item.required }))
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.userId)).limit(1)
  // A briefing enters the person's Coordinator chat: its bot row is resolved here. It summarises the account's
  // suggestions, which name no workspace: the personal workspace's Coordinator.
  const { botId } = await (await import('@/lib/coordinator/coordinator-bot')).coordinatorBot(row.userId, null)
  await recordCoordinatorEvent(db, briefingEvent({ ...row, counts: row.counts as Record<string, number> }, items, person?.name?.trim() || null, botId))
  return true
}

/**
 * Writes the daily briefing from the last 24 hours, also when it is empty, so
 * each local date gets at most one, and pushes it. It replaces only a `first`
 * briefing written before `dueAt`. `saved` is null when another writer got
 * there first.
 */
async function writeDailyBriefing(userId: string, timeZone: string, dueAt: Date, now: Date) {
  const row = await briefingRow(userId, timeZone, 'daily', now)
  const [saved] = await db.insert(briefings).values({ ...row, createdAt: now }).onConflictDoUpdate({
    target: [briefings.userId, briefings.localDate],
    set: { kind: row.kind, timeZone: row.timeZone, highlights: row.highlights, counts: row.counts, total: row.total, createdAt: now },
    setWhere: and(eq(briefings.kind, 'first'), lt(briefings.createdAt, dueAt)),
  }).returning()
  return { saved: saved ?? null, pushed: saved ? await pushBriefing(saved) : false }
}

/** 每日建议 is on: no user_preferences row, or both dailySuggestions and memoryEnabled (it needs 记忆). */
const dailySuggestionsAllowed = sql<boolean>`coalesce(${userPreferences.dailySuggestions} and ${userPreferences.memoryEnabled}, true)`

/** Whether the person's daily briefing (每日建议) may be written: the cron, the lazy read and the first briefing all skip them when off. */
export async function dailySuggestionsOn(userId: string): Promise<boolean> {
  const [row] = await db.select({ on: dailySuggestionsAllowed }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1)
  return row?.on ?? true
}

/**
 * The person's current briefing. The briefings cron writes the daily one at
 * 08:00 their time; this is the fallback when it has not run yet. Before
 * 08:00 it is the latest briefing from the last day (yesterday's, or one
 * written on connecting an app), so nothing is written early. `onPushed`
 * runs when this read wrote the day's briefing and queued it for the
 * Coordinator, so the caller can wake it.
 */
export async function todaysBriefing(userId: string, timeZoneName: string | null, { onPushed }: { onPushed?: () => void } = {}) {
  const timeZone = safeTimeZone(timeZoneName)
  const now = new Date()
  const { date: today, hour } = localClock(timeZone, now)
  if (hour < BRIEFING_HOUR) {
    const [latest] = await db.select().from(briefings).where(and(eq(briefings.userId, userId), gte(briefings.createdAt, new Date(now.getTime() - BRIEFING_WINDOW_MS)))).orderBy(desc(briefings.localDate)).limit(1)
    return shown(latest)
  }
  const todays = async () => (await db.select().from(briefings).where(and(eq(briefings.userId, userId), eq(briefings.localDate, today))).limit(1))[0]
  const existing = await todays()
  const dueAt = localInstant(timeZone, today, BRIEFING_HOUR)
  if (!pending(existing, dueAt) || !await dailySuggestionsOn(userId)) return shown(existing)
  const { saved, pushed } = await writeDailyBriefing(userId, timeZone, dueAt, now)
  if (pushed) onPushed?.()
  return shown(saved ?? await todays())
}

/**
 * Remembers the person's time zone for the briefings cron. An invalid name is
 * ignored. With `replace: false` it only fills a gap, so an IP-derived guess
 * never overrides the zone the person's browser reported. A zone the person
 * picked in Settings (source 'manual') is never replaced; a report then only
 * updates detectedTimeZone, which 自动 switches back to.
 */
export async function recordTimeZone(userId: string, timeZoneName: string | null, { replace = true } = {}) {
  if (!timeZoneName || safeTimeZone(timeZoneName) !== timeZoneName) return
  const now = new Date()
  const insert = db.insert(userTimeZones).values({ userId, timeZone: timeZoneName, source: 'auto', detectedTimeZone: timeZoneName, updatedAt: now })
  const manual = eq(userTimeZones.source, 'manual')
  await (replace
    ? insert.onConflictDoUpdate({
      target: userTimeZones.userId,
      set: { timeZone: sql`case when ${manual} then ${userTimeZones.timeZone} else excluded."timeZone" end`, detectedTimeZone: timeZoneName, updatedAt: now },
      setWhere: or(sql`${userTimeZones.detectedTimeZone} is distinct from ${timeZoneName}`, and(ne(userTimeZones.source, 'manual'), ne(userTimeZones.timeZone, timeZoneName))),
    })
    // An IP guess still fills a manual row's missing detected zone, so 自动 has something to go back to.
    : insert.onConflictDoUpdate({ target: userTimeZones.userId, set: { detectedTimeZone: timeZoneName }, setWhere: and(manual, isNull(userTimeZones.detectedTimeZone)) }))
}

/** How many briefings the cron writes at once. */
const BRIEFING_CONCURRENCY = 8

/**
 * Writes the daily briefing for everyone whose local time is past 08:00 and
 * who has none for today yet. Running every 15 minutes, a person's briefing
 * lands within 15 minutes of 08:00; a missed or cut-short run is caught up by
 * the next one the same local day. Safe to run concurrently: the
 * (userId, localDate) key keeps it to one per day. `pushed` lists the people
 * whose briefing was queued for the Coordinator; the caller wakes them.
 */
export async function writeDueBriefings({ now = new Date(), limit = 500, deadline = Infinity }: { now?: Date; limit?: number; deadline?: number } = {}) {
  const zones = (await db.selectDistinct({ timeZone: userTimeZones.timeZone }).from(userTimeZones)).map(row => row.timeZone)
  const people: { userId: string; timeZone: string; dueAt: Date }[] = []
  for (const zone of dueBriefingZones(zones, now)) {
    if (people.length > limit) break
    const rows = await db.select({ userId: userTimeZones.userId }).from(userTimeZones)
      .leftJoin(briefings, and(eq(briefings.userId, userTimeZones.userId), eq(briefings.localDate, zone.localDate)))
      .leftJoin(userPreferences, eq(userPreferences.userId, userTimeZones.userId))
      .where(and(eq(userTimeZones.timeZone, zone.timeZone), dailySuggestionsAllowed, or(isNull(briefings.userId), and(eq(briefings.kind, 'first'), lt(briefings.createdAt, zone.dueAt)))))
      .limit(limit + 1 - people.length)
    people.push(...rows.map(row => ({ userId: row.userId, timeZone: zone.timeZone, dueAt: zone.dueAt })))
  }
  const result = { zones: zones.length, due: Math.min(people.length, limit), written: 0, empty: 0, skipped: 0, failed: 0, deferred: Math.max(0, people.length - limit) }
  const pushed: string[] = []
  const batch = people.slice(0, limit)
  for (let index = 0; index < batch.length; index += BRIEFING_CONCURRENCY) {
    if (Date.now() > deadline) { result.deferred += batch.length - index; break }
    await Promise.all(batch.slice(index, index + BRIEFING_CONCURRENCY).map(async person => {
      try {
        const { saved, pushed: queued } = await writeDailyBriefing(person.userId, person.timeZone, person.dueAt, now)
        if (queued) pushed.push(person.userId)
        if (!saved) result.skipped++
        else if (saved.total) result.written++
        else result.empty++
      } catch (error) {
        result.failed++
        console.error('Daily briefing failed', error instanceof Error ? error.message : error)
      }
    }))
  }
  return { result, pushed }
}

/**
 * Writes the briefing right after the person connects an app, replacing
 * today's, and queues it for the Coordinator. True when it was queued.
 */
export async function writeFirstBriefing(userId: string, timeZoneName: string | null) {
  if (!await dailySuggestionsOn(userId)) return false
  const row = await briefingRow(userId, safeTimeZone(timeZoneName), 'first', new Date())
  const [saved] = await db.insert(briefings).values(row).onConflictDoUpdate({ target: [briefings.userId, briefings.localDate], set: { kind: row.kind, timeZone: row.timeZone, highlights: row.highlights, counts: row.counts, total: row.total, createdAt: new Date() } }).returning()
  return saved ? pushBriefing(saved) : false
}

/** The suggestions a briefing names, in its order, skipping any since dismissed. */
export async function briefingHighlights(userId: string, ids: readonly string[]) {
  if (!ids.length) return []
  const rows = await db.select().from(suggestions).where(and(eq(suggestions.userId, userId), inArray(suggestions.id, [...ids]), isNull(suggestions.dismissedAt)))
  return ids.flatMap(id => rows.filter(row => row.id === id))
}
