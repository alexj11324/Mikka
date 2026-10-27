import 'server-only'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { memorySettings, userFacts, userTimeZones } from '@/lib/db/schema'
import { personLocale } from '@/lib/suggestions/action-title-server'
import { localClock, safeTimeZone } from '@/lib/suggestions/briefing'
import type { UserFactKind } from './kinds'
import { clampSubject, mergedEvidence, mergedValue, planConsolidation, raisedConfidence, subjectKey, type FactInput } from './facts'

// Each person's profile (R-73). Every read and write is keyed by the person's
// own user id; nothing here takes a workspace, so teammates never see each
// other's facts.

/** Whether 记忆 is on for the person; no row means on. */
export async function memoryEnabled(userId: string): Promise<boolean> {
  const [row] = await db.select({ enabled: memorySettings.enabled }).from(memorySettings).where(eq(memorySettings.userId, userId)).limit(1)
  return row?.enabled ?? true
}

export async function setMemoryEnabled(userId: string, enabled: boolean): Promise<void> {
  await db.insert(memorySettings).values({ userId, enabled }).onConflictDoUpdate({ target: memorySettings.userId, set: { enabled, updatedAt: new Date() } })
}

/**
 * Writes facts for the person. A new fact is inserted; a repeat merges into
 * the stored one: confidence rises (a nightly pattern sets it instead),
 * lastSeenAt moves forward, value and evidence are merged, and an expired fact
 * comes back. A fact the person corrected only has lastSeenAt moved, and one
 * they deleted or said is wrong is left as it is.
 */
export async function recordFacts(userId: string, facts: readonly FactInput[], { pattern = false }: { pattern?: boolean } = {}): Promise<number> {
  let written = 0
  for (const fact of facts) {
    const key = subjectKey(fact.subject)
    if (!key) continue
    const subject = clampSubject(fact.subject)
    const [inserted] = await db.insert(userFacts).values({
      id: randomUUID(), userId, kind: fact.kind, subject, subjectKey: key, value: fact.value, evidence: fact.evidence,
      confidence: fact.confidence, firstSeenAt: fact.seenAt, lastSeenAt: fact.seenAt, expiresAt: fact.expiresAt,
    }).onConflictDoNothing().returning({ id: userFacts.id })
    if (inserted) { written++; continue }
    written += await db.transaction(async tx => {
      const [current] = await tx.select().from(userFacts).where(and(eq(userFacts.userId, userId), eq(userFacts.kind, fact.kind), eq(userFacts.subjectKey, key))).for('update').limit(1)
      if (!current || current.state === 'deleted' || current.state === 'dismissed') return 0
      const lastSeenAt = current.lastSeenAt > fact.seenAt ? current.lastSeenAt : fact.seenAt
      if (current.userEdited) {
        await tx.update(userFacts).set({ lastSeenAt, updatedAt: new Date() }).where(eq(userFacts.id, current.id))
        return 0
      }
      await tx.update(userFacts).set({
        value: mergedValue(current.value, fact.value), evidence: mergedEvidence(current.evidence, fact.evidence),
        confidence: pattern ? fact.confidence : raisedConfidence(current.confidence, fact.confidence),
        lastSeenAt, expiresAt: fact.expiresAt ?? current.expiresAt, state: 'active', updatedAt: new Date(),
      }).where(eq(userFacts.id, current.id))
      return 1
    })
  }
  return written
}

const shownColumns = { id: userFacts.id, kind: userFacts.kind, subject: userFacts.subject, value: userFacts.value, confidence: userFacts.confidence, lastSeenAt: userFacts.lastSeenAt, expiresAt: userFacts.expiresAt, userEdited: userFacts.userEdited }
export type ShownFact = { id: string; kind: UserFactKind; subject: string; value: Record<string, unknown>; confidence: number; lastSeenAt: Date; expiresAt: Date | null; userEdited: boolean }

/** The person's active facts for 记忆, most certain first within each kind. */
export async function listFacts(userId: string): Promise<ShownFact[]> {
  return db.select(shownColumns).from(userFacts).where(and(eq(userFacts.userId, userId), eq(userFacts.state, 'active')))
    .orderBy(asc(userFacts.kind), desc(userFacts.confidence), desc(userFacts.lastSeenAt)).limit(500)
}

/**
 * Removes a fact from 记忆. The row stays as `deleted` with its details and
 * evidence cleared, so the same fact is not learnt again. False when it is
 * not the person's.
 */
export async function deleteFact(userId: string, id: string): Promise<boolean> {
  const rows = await db.update(userFacts).set({ state: 'deleted', value: {}, evidence: [], updatedAt: new Date() })
    .where(and(eq(userFacts.id, id), eq(userFacts.userId, userId), ne(userFacts.state, 'deleted'))).returning({ id: userFacts.id })
  return rows.length > 0
}

/**
 * The person's correction of a fact's subject. It becomes theirs: the model
 * no longer changes it and the nightly merge does not fade it. A correction
 * onto another fact of the same kind keeps that one and removes this one.
 * False when the fact is not the person's or the subject is empty.
 */
export async function correctFact(userId: string, id: string, subjectText: string): Promise<boolean> {
  const subject = clampSubject(subjectText)
  const key = subjectKey(subject)
  if (!key) return false
  return db.transaction(async tx => {
    const [fact] = await tx.select({ id: userFacts.id, kind: userFacts.kind }).from(userFacts)
      .where(and(eq(userFacts.id, id), eq(userFacts.userId, userId), ne(userFacts.state, 'deleted'))).for('update').limit(1)
    if (!fact) return false
    const now = new Date()
    const corrected = { subject, subjectKey: key, state: 'active' as const, userEdited: true, confidence: 1, lastSeenAt: now, updatedAt: now }
    const [other] = await tx.select({ id: userFacts.id }).from(userFacts)
      .where(and(eq(userFacts.userId, userId), eq(userFacts.kind, fact.kind), eq(userFacts.subjectKey, key), ne(userFacts.id, id))).for('update').limit(1)
    if (!other) {
      await tx.update(userFacts).set(corrected).where(eq(userFacts.id, id))
      return true
    }
    await tx.update(userFacts).set({ state: 'deleted', value: {}, evidence: [], updatedAt: now }).where(eq(userFacts.id, id))
    await tx.update(userFacts).set(corrected).where(eq(userFacts.id, other.id))
    return true
  })
}

/** Runs one night's merge for the person (lib/profile/facts.ts planConsolidation). */
export async function consolidateFacts(userId: string, timeZone: string, now = new Date()) {
  const facts = await db.select({
    id: userFacts.id, kind: userFacts.kind, subject: userFacts.subject, subjectKey: userFacts.subjectKey, value: userFacts.value, confidence: userFacts.confidence,
    lastSeenAt: userFacts.lastSeenAt, expiresAt: userFacts.expiresAt, state: userFacts.state, userEdited: userFacts.userEdited,
  }).from(userFacts).where(and(eq(userFacts.userId, userId), eq(userFacts.state, 'active')))
  const { updates, patterns } = planConsolidation(facts, { now, timeZone: safeTimeZone(timeZone), locale: await personLocale(userId) })
  for (const change of updates) {
    await db.update(userFacts).set({ ...change, updatedAt: now }).where(and(eq(userFacts.id, change.id), eq(userFacts.userId, userId)))
  }
  const merged = await recordFacts(userId, patterns, { pattern: true })
  return { changed: updates.length, merged }
}

/** The nightly merge runs from this local hour, before the 05:00 research run and the 08:00 briefing. */
export const CONSOLIDATION_HOUR = 4
/** How many people the cron merges at once. */
const CONSOLIDATION_CONCURRENCY = 8

/**
 * Merges the facts of everyone with 记忆 on whose local time is past 04:00
 * and who has not been merged on their local date yet. Run hourly; a person
 * without a stored time zone is merged on UTC dates. Claiming the date first
 * keeps overlapping runs to one merge per person and day.
 */
export async function consolidateDueFacts({ now = new Date(), limit = 500, deadline = Infinity }: { now?: Date; limit?: number; deadline?: number } = {}) {
  const people = await db.selectDistinct({ userId: userFacts.userId, timeZone: userTimeZones.timeZone, enabled: memorySettings.enabled, consolidatedOn: memorySettings.consolidatedOn })
    .from(userFacts)
    .leftJoin(userTimeZones, eq(userTimeZones.userId, userFacts.userId))
    .leftJoin(memorySettings, eq(memorySettings.userId, userFacts.userId))
    .where(eq(userFacts.state, 'active'))
  const due = people.flatMap(person => {
    if (person.enabled === false) return []
    const timeZone = safeTimeZone(person.timeZone)
    const { date, hour } = localClock(timeZone, now)
    return hour >= CONSOLIDATION_HOUR && person.consolidatedOn !== date ? [{ userId: person.userId, timeZone, date }] : []
  })
  const result = { people: people.length, due: Math.min(due.length, limit), written: 0, skipped: 0, failed: 0, deferred: Math.max(0, due.length - limit) }
  const batch = due.slice(0, limit)
  for (let index = 0; index < batch.length; index += CONSOLIDATION_CONCURRENCY) {
    if (Date.now() > deadline) { result.deferred += batch.length - index; break }
    await Promise.all(batch.slice(index, index + CONSOLIDATION_CONCURRENCY).map(async person => {
      try {
        const [claimed] = await db.insert(memorySettings).values({ userId: person.userId, consolidatedOn: person.date })
          .onConflictDoUpdate({ target: memorySettings.userId, set: { consolidatedOn: person.date, updatedAt: now }, setWhere: and(eq(memorySettings.enabled, true), sql`${memorySettings.consolidatedOn} is distinct from ${person.date}`) })
          .returning({ userId: memorySettings.userId })
        if (!claimed) { result.skipped++; return }
        await consolidateFacts(person.userId, person.timeZone, now)
        result.written++
      } catch (error) {
        result.failed++
        console.error('Fact consolidation failed', error instanceof Error ? error.message : error)
      }
    }))
  }
  return result
}

