import 'server-only'
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { continuedLevel } from '@/lib/attention/judgment'
import { scoreNotification } from '@/lib/attention/score'
import { judgmentContext, matterContext, recordNotice } from '@/lib/attention/store'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { db } from '@/lib/db'
import { briefings, suggestions } from '@/lib/db/schema'
import { BRIEFING_WINDOW_MS, briefingContent, localDate, safeTimeZone } from './briefing'
import type { ExternalNotification } from './notification'

/** How far back the list reaches; older suggestions drop off. */
const LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const LIST_LIMIT = 100

/**
 * Rates each new notification once with the attention model (R-20) and
 * stores it; repeats are skipped before any model call. Every level but low
 * shows in 建议. Critical, high and ask go on their matter, which the person's
 * Coordinator is handed (lib/attention/store.ts); a later notice on a matter
 * the person has not answered never rates below it. `route: false` only
 * rates and stores, for what was already there when an app was connected.
 */
export async function ingestNotifications(notifications: readonly ExternalNotification[], { route = true } = {}) {
  const woken = new Set<string>()
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
    const [stored] = await db.insert(suggestions).values({
      id, userId: notification.userId, source: notification.source, externalId: notification.externalId, matterKey: notification.matterKey,
      action: notification.action, title: notification.title, url: notification.url, actor: notification.actor,
      shown: level !== 'low', decidedBy: score.decidedBy, level, required: notification.required,
      occurredAt: notification.occurredAt,
    }).onConflictDoNothing().returning({ id: suggestions.id })
    if (stored && route && await recordNotice(notification, id, { ...score, level }, continuesId)) woken.add(notification.userId)
  }))
  // The Coordinator's wake hands the next waiting matter over, one at a time.
  for (const userId of woken) await wakeCoordinator(userId)
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

/**
 * Today's briefing in the person's time zone. The first read on a new day
 * writes the daily one from the last 24 hours; a day with nothing to say has
 * no briefing, so the UI shows its empty state.
 */
export async function todaysBriefing(userId: string, timeZoneName: string | null) {
  const timeZone = safeTimeZone(timeZoneName)
  const now = new Date()
  const today = localDate(timeZone, now)
  const [existing] = await db.select().from(briefings).where(and(eq(briefings.userId, userId), eq(briefings.localDate, today))).limit(1)
  if (existing) return existing
  const row = await briefingRow(userId, timeZone, 'daily', now)
  if (!row.total) return null
  const [saved] = await db.insert(briefings).values(row).onConflictDoNothing().returning()
  return saved ?? (await db.select().from(briefings).where(and(eq(briefings.userId, userId), eq(briefings.localDate, today))).limit(1))[0] ?? null
}

/** Writes the briefing right after the person connects an app, replacing today's. */
export async function writeFirstBriefing(userId: string, timeZoneName: string | null) {
  const row = await briefingRow(userId, safeTimeZone(timeZoneName), 'first', new Date())
  await db.insert(briefings).values(row).onConflictDoUpdate({ target: [briefings.userId, briefings.localDate], set: { kind: row.kind, timeZone: row.timeZone, highlights: row.highlights, counts: row.counts, total: row.total, createdAt: new Date() } })
}

/** The suggestions a briefing names, in its order, skipping any since dismissed. */
export async function briefingHighlights(userId: string, ids: readonly string[]) {
  if (!ids.length) return []
  const rows = await db.select().from(suggestions).where(and(eq(suggestions.userId, userId), inArray(suggestions.id, [...ids]), isNull(suggestions.dismissedAt)))
  return ids.flatMap(id => rows.filter(row => row.id === id))
}
