import 'server-only'
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { db } from '@/lib/db'
import { proactiveUsage, userFactConsolidations, userFactDecisions, userFactUndo, userFacts, userPreferences, userTimeZones } from '@/lib/db/schema'
import { personLocale } from '@/lib/suggestions/action-title-server'
import { localClock, safeTimeZone } from '@/lib/suggestions/briefing'
import type { UserFactKind } from './kinds'
import { clampSubject, EVIDENCE_MAX, mergedEvidence, mergedValue, planConsolidation, raisedConfidence, subjectKey, type ConsolidationDecider, type FactInput } from './facts'

// Each person's profile (R-73). Every read and write is keyed by the person's
// own user id; nothing here takes a workspace, so teammates never see each
// other's facts.

/**
 * Whether 记忆 is on for the person: user_preferences."memoryEnabled", the one
 * switch web and mobile Settings write (lib/preferences.ts); no row means on.
 */
export async function memoryEnabled(userId: string): Promise<boolean> {
  const [row] = await db.select({ enabled: userPreferences.memoryEnabled }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1)
  return row?.enabled ?? true
}

/** Profile model calls one person may make per UTC day (proactive.md § 3). */
export const PROFILE_DAILY_CALLS = 200

/** The UTC day usage is counted on. */
export const usageDay = (now: Date) => now.toISOString().slice(0, 10)

/** Takes one extraction call from the person's budget for `day`; false when it is spent. Counted before the call, so a failed call still counts. */
export async function claimExtractionCall(userId: string, day: string, dailyCalls = PROFILE_DAILY_CALLS): Promise<boolean> {
  if (dailyCalls <= 0) return false
  const [row] = await db.insert(proactiveUsage).values({ userId, day, kind: 'extraction', calls: 1 }).onConflictDoUpdate({
    target: [proactiveUsage.userId, proactiveUsage.day, proactiveUsage.kind],
    set: { calls: sql`${proactiveUsage.calls} + 1`, updatedAt: new Date() },
    setWhere: sql`${proactiveUsage.calls} < ${dailyCalls}`,
  }).returning({ calls: proactiveUsage.calls })
  return !!row
}

/** Adds a finished call's tokens to the person's usage for `day`. */
export async function recordExtractionTokens(userId: string, day: string, inputTokens: number, outputTokens: number): Promise<void> {
  await db.update(proactiveUsage).set({ inputTokens: sql`${proactiveUsage.inputTokens} + ${inputTokens}`, outputTokens: sql`${proactiveUsage.outputTokens} + ${outputTokens}`, updatedAt: new Date() })
    .where(and(eq(proactiveUsage.userId, userId), eq(proactiveUsage.day, day), eq(proactiveUsage.kind, 'extraction')))
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
    written += await db.transaction(async tx => {
      const parents = [...new Set(fact.evidence.filter(item => item.source === 'consolidation').flatMap(item => item.factIds ?? []))].sort()
      if (pattern) {
        if (parents.length < 1 || parents.length > EVIDENCE_MAX || parents.some(id => !z.uuid().safeParse(id).success)) return 0
        // Consolidation has only a global contract. Never widen restricted or
        // changed parents; hold their scope until the derived write commits.
        const allowed = await tx.select({ id: userFacts.id }).from(userFacts).where(and(
          inArray(userFacts.id, parents), eq(userFacts.userId, userId), eq(userFacts.state, 'active'), eq(userFacts.scopeKind, 'global'),
        )).orderBy(asc(userFacts.id)).for('share')
        if (allowed.length !== parents.length) return 0
      }
      const persistDecision = async (factId: string) => {
        const decisionKey = createHash('sha256').update(JSON.stringify([factId, fact.seenAt.toISOString(), parents, fact.value])).digest('hex')
        const [inserted] = await tx.insert(userFactDecisions).values({ id: randomUUID(), userId, factId, sourceFactIds: parents,
          method: 'consolidation_answer', decisionKey, decidedAt: fact.seenAt,
        }).onConflictDoNothing().returning({ id: userFactDecisions.id })
        if (inserted) return inserted.id
        const [existing] = await tx.select({ id: userFactDecisions.id }).from(userFactDecisions).where(and(
          eq(userFactDecisions.userId, userId), eq(userFactDecisions.decisionKey, decisionKey), eq(userFactDecisions.factId, factId),
        )).limit(1)
        if (!existing) throw new Error('memory_decision_record_missing')
        return existing.id
      }
      const [inserted] = await tx.insert(userFacts).values({
        id: randomUUID(), userId, kind: fact.kind, subject, subjectKey: key, value: fact.value, evidence: fact.evidence,
        confidence: fact.confidence, firstSeenAt: fact.seenAt, lastSeenAt: fact.seenAt, expiresAt: fact.expiresAt,
        reviewStatus: 'pending', sourceKind: pattern ? null : fact.source?.kind ?? null,
        sourceId: pattern ? null : fact.source?.id ?? null, sourceUrl: pattern ? null : fact.source?.url ?? null,
      }).onConflictDoNothing().returning({ id: userFacts.id })
      if (inserted) {
        if (pattern) await tx.update(userFacts).set({ sourceKind: 'decision', sourceId: await persistDecision(inserted.id), sourceUrl: null }).where(eq(userFacts.id, inserted.id))
        // Facts in the same semantic slot may contradict an earlier approval.
        if (typeof fact.value.slot === 'string') await tx.update(userFacts).set({ reviewStatus: 'pending', updatedAt: new Date() }).where(and(
          eq(userFacts.userId, userId), eq(userFacts.kind, fact.kind), eq(userFacts.state, 'active'), sql`${userFacts.value} ->> 'slot' = ${fact.value.slot}`,
        ))
        return 1
      }
      const [current] = await tx.select().from(userFacts).where(and(eq(userFacts.userId, userId), eq(userFacts.kind, fact.kind), eq(userFacts.subjectKey, key))).for('update').limit(1)
      if (!current || current.state === 'deleted' || current.state === 'dismissed') return 0
      if (pattern && (current.scopeKind !== 'global' || parents.includes(current.id))) return 0
      const lastSeenAt = current.lastSeenAt > fact.seenAt ? current.lastSeenAt : fact.seenAt
      if (current.userEdited) {
        await tx.update(userFacts).set({ lastSeenAt, updatedAt: new Date() }).where(eq(userFacts.id, current.id))
        return 0
      }
      await tx.update(userFacts).set({
        value: mergedValue(current.value, fact.value), evidence: mergedEvidence(current.evidence, fact.evidence),
        confidence: pattern ? fact.confidence : raisedConfidence(current.confidence, fact.confidence),
        lastSeenAt, expiresAt: fact.expiresAt ?? current.expiresAt, state: 'active', updatedAt: new Date(),
        ...(pattern ? { sourceKind: 'decision' as const, sourceId: await persistDecision(current.id), sourceUrl: null }
          : !current.sourceKind && fact.source ? { sourceKind: fact.source.kind, sourceId: fact.source.id, sourceUrl: fact.source.url } : {}),
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
  return db.transaction(async tx => {
    const rows = await tx.update(userFacts).set({ state: 'deleted', value: {}, evidence: [], sourceKind: null, sourceId: null, sourceUrl: null, updatedAt: new Date() })
      .where(and(eq(userFacts.id, id), eq(userFacts.userId, userId), ne(userFacts.state, 'deleted'))).returning({ id: userFacts.id })
    if (rows.length) await tx.delete(userFactDecisions).where(and(eq(userFactDecisions.userId, userId), eq(userFactDecisions.factId, id)))
    return rows.length > 0
  })
}

/** How many active facts the person has (listFacts shows at most 500). */
export async function countFacts(userId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(userFacts).where(and(eq(userFacts.userId, userId), eq(userFacts.state, 'active')))
  return row?.count ?? 0
}

/**
 * Removes every fact from 记忆 the way deleteFact removes one: rows stay as
 * `deleted` with details and evidence cleared, so they are not learnt again.
 * Expired and dismissed facts are cleared too. Returns how many of the
 * removed facts were active, the count 记忆 showed.
 */
export async function clearFacts(userId: string): Promise<number> {
  return db.transaction(async tx => {
    const active = await tx.select({ id: userFacts.id }).from(userFacts).where(and(eq(userFacts.userId, userId), eq(userFacts.state, 'active'))).for('update')
    await tx.delete(userFactUndo).where(eq(userFactUndo.userId, userId))
    await tx.delete(userFactDecisions).where(eq(userFactDecisions.userId, userId))
    await tx.update(userFacts).set({ state: 'deleted', value: {}, evidence: [], sourceKind: null, sourceId: null, sourceUrl: null, updatedAt: new Date() })
      .where(eq(userFacts.userId, userId))
    return active.length
  })
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
    const corrected = { subject, subjectKey: key, state: 'active' as const, reviewStatus: 'approved' as const, userEdited: true, confidence: 1, lastSeenAt: now, updatedAt: now }
    const [other] = await tx.select({ id: userFacts.id }).from(userFacts)
      .where(and(eq(userFacts.userId, userId), eq(userFacts.kind, fact.kind), eq(userFacts.subjectKey, key), ne(userFacts.id, id))).for('update').limit(1)
    if (!other) {
      await tx.update(userFacts).set(corrected).where(eq(userFacts.id, id))
      return true
    }
    await tx.update(userFacts).set({ state: 'deleted', value: {}, evidence: [], sourceKind: null, sourceId: null, sourceUrl: null, updatedAt: now }).where(eq(userFacts.id, id))
    await tx.delete(userFactDecisions).where(and(eq(userFactDecisions.userId, userId), eq(userFactDecisions.factId, id)))
    await tx.update(userFacts).set(corrected).where(eq(userFacts.id, other.id))
    return true
  })
}

/** The real Decision API for one person's nightly merge, billed to their execution workspace. */
export function consolidationDecider(userId: string): ConsolidationDecider {
  return async (input, questions) => {
    try {
      const [{ hostedBillingScope }, { executionWorkspace }, { decide }] = await Promise.all([
        import('@/lib/abuse/context'), import('@/lib/execution-settings'), import('@/lib/coordinator/decide'),
      ])
      const workspaceId = await executionWorkspace(userId, null)
      return await hostedBillingScope.run({ workspaceId, ownerId: userId }, () => decide('profile-consolidation', input, questions))
    } catch {
      // decide() never throws; a budget or workspace lookup failure is also no answer.
      return null
    }
  }
}

/**
 * Runs one night's merge for the person (lib/profile/facts.ts planConsolidation).
 * Reads, asks the Decision API with nothing locked, then writes each judged
 * change only if the fact is still active, uncorrected and not seen since.
 */
export async function consolidateFacts(userId: string, timeZone: string, now = new Date(), decide: ConsolidationDecider = consolidationDecider(userId)) {
  const facts = await db.select({
    id: userFacts.id, kind: userFacts.kind, subject: userFacts.subject, subjectKey: userFacts.subjectKey, value: userFacts.value, confidence: userFacts.confidence,
    lastSeenAt: userFacts.lastSeenAt, expiresAt: userFacts.expiresAt, state: userFacts.state, userEdited: userFacts.userEdited,
  }).from(userFacts).where(and(eq(userFacts.userId, userId), eq(userFacts.state, 'active'), eq(userFacts.scopeKind, 'global')))
  const { updates, patterns } = await planConsolidation(facts, { now, timeZone: safeTimeZone(timeZone), locale: await personLocale(userId) }, decide)
  let changed = 0
  for (const { id, unchangedSince, ...change } of updates) {
    const rows = await db.update(userFacts).set({ ...change, updatedAt: now }).where(and(
      eq(userFacts.id, id), eq(userFacts.userId, userId), eq(userFacts.state, 'active'), eq(userFacts.scopeKind, 'global'),
      // Timestamps are stored to the microsecond and read to the millisecond.
      ...(unchangedSince ? [eq(userFacts.userEdited, false), lt(userFacts.lastSeenAt, new Date(unchangedSince.getTime() + 1))] : []),
    )).returning({ id: userFacts.id })
    changed += rows.length
  }
  const merged = await recordFacts(userId, patterns, { pattern: true })
  return { changed, merged }
}

/** The nightly merge runs from this local hour, before the 05:00 research run and the 08:00 briefing. */
export const CONSOLIDATION_HOUR = 4
/** How many people the cron merges at once. */
const CONSOLIDATION_CONCURRENCY = 8

/**
 * Merges the facts of everyone with 记忆 on whose local time is past 04:00,
 * who has not been merged on their local date yet, and whom `entitled`
 * allows (the PostHog flag; lib/profile/entitlement.ts). Run hourly; a
 * person without a stored time zone is merged on UTC dates. Claiming the date
 * first keeps overlapping runs to one merge per person and day.
 */
export async function consolidateDueFacts({ entitled, now = new Date(), limit = 500, deadline = Infinity, decider = consolidationDecider }: { entitled: (userId: string) => Promise<boolean>; now?: Date; limit?: number; deadline?: number; decider?: (userId: string) => ConsolidationDecider }) {
  const people = await db.selectDistinct({ userId: userFacts.userId, timeZone: userTimeZones.timeZone, enabled: userPreferences.memoryEnabled, consolidatedOn: userFactConsolidations.consolidatedOn })
    .from(userFacts)
    .leftJoin(userTimeZones, eq(userTimeZones.userId, userFacts.userId))
    .leftJoin(userPreferences, eq(userPreferences.userId, userFacts.userId))
    .leftJoin(userFactConsolidations, eq(userFactConsolidations.userId, userFacts.userId))
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
        if (!await entitled(person.userId)) { result.skipped++; return }
        const [claimed] = await db.insert(userFactConsolidations).values({ userId: person.userId, consolidatedOn: person.date })
          .onConflictDoUpdate({ target: userFactConsolidations.userId, set: { consolidatedOn: person.date, updatedAt: now }, setWhere: sql`${userFactConsolidations.consolidatedOn} is distinct from ${person.date}` })
          .returning({ userId: userFactConsolidations.userId })
        if (!claimed) { result.skipped++; return }
        await consolidateFacts(person.userId, person.timeZone, now, decider(person.userId))
        result.written++
      } catch (error) {
        result.failed++
        console.error('Fact consolidation failed', error instanceof Error ? error.message : error)
      }
    }))
  }
  return result
}

