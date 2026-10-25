import 'server-only'
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { decide } from '@/lib/coordinator/decide'
import { decisionInput } from '@/lib/coordinator/decision'
import { db } from '@/lib/db'
import { briefings, suggestions } from '@/lib/db/schema'
import { BRIEFING_WINDOW_MS, briefingContent, localDate, safeTimeZone } from './briefing'
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
