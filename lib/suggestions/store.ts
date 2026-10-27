import 'server-only'
import { and, desc, eq, gte, inArray, isNull, lt, ne, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { decide } from '@/lib/coordinator/decide'
import { decisionInput } from '@/lib/coordinator/decision'
import { briefingEvent } from '@/lib/coordinator-events'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { db } from '@/lib/db'
import { briefings, suggestions, users, userTimeZones } from '@/lib/db/schema'
import { BRIEFING_HOUR, BRIEFING_WINDOW_MS, briefingContent, dueBriefingZones, localClock, localDate, localInstant, safeTimeZone } from './briefing'
import type { ExternalNotification } from './notification'
import { fallbackVerdict, modelVerdict, ruleVerdict, suggestionQuestions, suggestionState, type Verdict } from './rules'

/** How far back the list reaches; older suggestions drop off. */
const LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const LIST_LIMIT = 100

async function judge(notification: ExternalNotification): Promise<Verdict> {
  const ruled = ruleVerdict(notification)
  if (ruled) return ruled
  const answers = await decide('suggestion', decisionInput(suggestionState(notification)), suggestionQuestions())
  const answer = answers?.get('worthShowing')
  return answer?.type === 'predicate' ? modelVerdict(answer.probability) : fallbackVerdict(notification)
}

/** Judges each new notification once and stores the verdict; repeats are skipped before any model call. */
export async function ingestNotifications(notifications: readonly ExternalNotification[]) {
  await Promise.all(notifications.map(async notification => {
    const [seen] = await db.select({ id: suggestions.id }).from(suggestions)
      .where(and(eq(suggestions.userId, notification.userId), eq(suggestions.source, notification.source), eq(suggestions.externalId, notification.externalId))).limit(1)
    if (seen) return
    const verdict = await judge(notification)
    await db.insert(suggestions).values({
      id: randomUUID(), userId: notification.userId, source: notification.source, externalId: notification.externalId,
      action: notification.action, title: notification.title, url: notification.url, actor: notification.actor,
      shown: verdict.shown, decidedBy: verdict.decidedBy, probability: verdict.probability, required: notification.required,
      occurredAt: notification.occurredAt,
    }).onConflictDoNothing()
  }))
}

const visible = (userId: string, since: Date) => and(eq(suggestions.userId, userId), eq(suggestions.shown, true), isNull(suggestions.dismissedAt), gte(suggestions.createdAt, since))

/** What the person sees: shown, not dismissed, from the last week, newest first. */
export async function listSuggestions(userId: string) {
  return db.select().from(suggestions).where(visible(userId, new Date(Date.now() - LIST_WINDOW_MS))).orderBy(desc(suggestions.occurredAt)).limit(LIST_LIMIT)
}

/** Takes a suggestion off the person's list. False when it is not theirs. */
export async function dismissSuggestion(userId: string, id: string) {
  const rows = await db.update(suggestions).set({ dismissedAt: new Date() }).where(and(eq(suggestions.id, id), eq(suggestions.userId, userId), isNull(suggestions.dismissedAt))).returning({ id: suggestions.id })
  return rows.length > 0
}

async function briefingRow(userId: string, timeZone: string, kind: 'first' | 'daily', now: Date) {
  const items = await db.select().from(suggestions).where(visible(userId, new Date(now.getTime() - BRIEFING_WINDOW_MS)))
  return { userId, localDate: localDate(timeZone, now), kind, timeZone, ...briefingContent(items) }
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
  const items = (await briefingHighlights(row.userId, row.highlights)).map(item => ({ suggestionId: item.id, source: item.source, action: item.action, title: item.title, actor: item.actor, url: item.url, required: item.required }))
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.userId)).limit(1)
  await recordCoordinatorEvent(db, briefingEvent({ ...row, counts: row.counts as Record<string, number> }, items, person?.name?.trim() || null))
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
  if (!pending(existing, dueAt)) return shown(existing)
  const { saved, pushed } = await writeDailyBriefing(userId, timeZone, dueAt, now)
  if (pushed) onPushed?.()
  return shown(saved ?? await todays())
}

/**
 * Remembers the person's time zone for the briefings cron. An invalid name is
 * ignored. With `replace: false` it only fills a gap, so an IP-derived guess
 * never overrides the zone the person's browser reported.
 */
export async function recordTimeZone(userId: string, timeZoneName: string | null, { replace = true } = {}) {
  if (!timeZoneName || safeTimeZone(timeZoneName) !== timeZoneName) return
  const now = new Date()
  const insert = db.insert(userTimeZones).values({ userId, timeZone: timeZoneName, updatedAt: now })
  await (replace
    ? insert.onConflictDoUpdate({ target: userTimeZones.userId, set: { timeZone: timeZoneName, updatedAt: now }, setWhere: ne(userTimeZones.timeZone, timeZoneName) })
    : insert.onConflictDoNothing())
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
      .where(and(eq(userTimeZones.timeZone, zone.timeZone), or(isNull(briefings.userId), and(eq(briefings.kind, 'first'), lt(briefings.createdAt, zone.dueAt)))))
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
