import 'server-only'
import { and, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { attentionLog, attentionMatters, attentionSettings, coordinatorEvents, type AttentionMatterState } from '@/lib/db/schema'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { BUDGET_WINDOW_MS, BUDGETS, budgetState, type BudgetKind } from './budget'
import { mergeEvidence, notice, stateAfterNotice, type BudgetView, type HandoffPayload, type ItemEvidence } from './handoff'
import { higherLevel, isRouted, levelRank, type MatterContext } from './judgment'
import { onPersonTold } from './push'
import type { Score } from './score'

// The person's matters from connected apps, their two budgets and the
// Coordinator's decisions (R-20). Ingest records a notice on its matter; a
// matter at a routed level waits until the handoff budget allows it and no
// other matter is in the Coordinator's hands, then goes over as a hidden
// `matter_handoff` event. The Coordinator records notify, quiet, snooze or
// handled with record_attention. Nothing is dropped: a matter that cannot go
// over now keeps waiting.

/** Recent matters the judgment may link a notice to. */
const MATTERS_FOR_JUDGMENT = 10
const MATTERS_DAYS = 60
/** A matter in the Coordinator's hands this long without a decision counts as quiet, so the next one can go over. */
const HANDED_STALE_MS = 30 * 60_000

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Matter = typeof attentionMatters.$inferSelect

async function lock(tx: Tx, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attention:${userId}`}, 0))`)
}

/** The person's switch; on unless they turned it off. */
export async function attentionEnabled(userId: string, executor: Pick<typeof db, 'select'> = db): Promise<boolean> {
  const [row] = await executor.select({ enabled: attentionSettings.enabled }).from(attentionSettings).where(eq(attentionSettings.userId, userId)).limit(1)
  return row?.enabled ?? true
}

/** Turns matters from connected apps on or off. Off settles what waits as quiet; 建议 keeps filling either way. */
export async function setAttentionEnabled(userId: string, enabled: boolean): Promise<void> {
  await db.transaction(async tx => {
    await lock(tx, userId)
    await tx.insert(attentionSettings).values({ userId, enabled }).onConflictDoUpdate({ target: attentionSettings.userId, set: { enabled, updatedAt: new Date() } })
    if (enabled) return
    const settled = await tx.update(attentionMatters).set({ state: 'quiet', reason: 'the person turned matters off', updatedAt: new Date() })
      .where(and(eq(attentionMatters.userId, userId), inArray(attentionMatters.state, ['waiting', 'snoozed']))).returning({ id: attentionMatters.id })
    if (settled.length) await tx.insert(attentionLog).values(settled.map(row => ({ id: randomUUID(), userId, matterId: row.id, action: 'quiet' as const, spends: false, reason: 'the person turned matters off' })))
  })
}

function context(matter: Matter, id = matter.id): MatterContext {
  return { id, title: matter.title, level: matter.level, state: matter.state, reason: matter.reason }
}

const byKey = (userId: string, key: string) => and(eq(attentionMatters.userId, userId),
  or(eq(attentionMatters.matterKey, key), sql`${attentionMatters.evidence}->'keys' @> ${JSON.stringify([key])}::jsonb`))

/**
 * What the judgment reads about earlier matters: the one this notice's thread
 * already belongs to, and the person's other recent matters under short ids
 * (m1, m2…) for the `continues` question. `ids` maps a short id back.
 */
export async function judgmentContext(userId: string, key: string, now = new Date()): Promise<{ same: MatterContext | null; matters: MatterContext[]; ids: Map<string, string> }> {
  const [same] = await db.select().from(attentionMatters).where(byKey(userId, key)).limit(1)
  const recent = await db.select().from(attentionMatters)
    .where(and(eq(attentionMatters.userId, userId), gte(attentionMatters.updatedAt, new Date(now.getTime() - MATTERS_DAYS * 86_400_000)), ...(same ? [ne(attentionMatters.id, same.id)] : [])))
    .orderBy(desc(attentionMatters.updatedAt)).limit(MATTERS_FOR_JUDGMENT)
  const ids = new Map(recent.map((matter, index) => [`m${index + 1}`, matter.id]))
  return { same: same ? context(same) : null, matters: recent.map((matter, index) => context(matter, `m${index + 1}`)), ids }
}

/** The matter a judged notice continues, by real id, when the person has not answered it. */
export async function matterContext(userId: string, id: string): Promise<MatterContext | null> {
  const [matter] = await db.select().from(attentionMatters).where(and(eq(attentionMatters.id, id), eq(attentionMatters.userId, userId))).limit(1)
  return matter ? context(matter) : null
}

/**
 * Records a notice on its matter: the thread's own matter, else the earlier
 * matter the judgment linked, else a new one when the level is routed.
 * Returns whether a matter now waits to go over.
 */
export async function recordNotice(notification: ExternalNotification, suggestionId: string, score: Score, continuesId: string | null): Promise<boolean> {
  const { userId, matterKey } = notification
  return db.transaction(async tx => {
    await lock(tx, userId)
    if (!await attentionEnabled(userId, tx)) return false
    const [same] = await tx.select().from(attentionMatters).where(byKey(userId, matterKey)).limit(1)
    const [linked] = same || !continuesId ? [] : await tx.select().from(attentionMatters).where(and(eq(attentionMatters.id, continuesId), eq(attentionMatters.userId, userId))).limit(1)
    const target = same ?? linked
    const routed = isRouted(score.level)
    const now = new Date()
    if (!target) {
      if (!routed) return false
      await tx.insert(attentionMatters).values({
        id: randomUUID(), userId, matterKey, source: notification.source, suggestionId, title: notification.title, url: notification.url,
        level: score.level, assessment: { ...score.assessment }, evidence: { ...mergeEvidence(null, notice(notification), matterKey) }, state: 'waiting',
      }).onConflictDoNothing()
      return true
    }
    const next = stateAfterNotice(target, score.level, routed)
    const level = target.state === 'handled' && next ? score.level : higherLevel(score.level, target.level)
    await tx.update(attentionMatters).set({
      suggestionId, url: notification.url ?? target.url, level,
      // A notice the model judged supersedes the earlier assessment; a rule or fallback keeps it.
      ...(score.assessment ? { assessment: { ...score.assessment } } : {}),
      evidence: { ...mergeEvidence(target.evidence as unknown as ItemEvidence, notice(notification), matterKey) },
      ...(next ? { state: next, recheck: false, runAt: null } : {}),
      updatedAt: now,
    }).where(eq(attentionMatters.id, target.id))
    return next === 'waiting' || target.state === 'waiting'
  })
}

async function spends(tx: Pick<typeof db, 'select'>, userId: string, kind: BudgetKind, now: Date): Promise<Date[]> {
  const rows = await tx.select({ at: attentionLog.createdAt }).from(attentionLog)
    .where(and(eq(attentionLog.userId, userId), eq(attentionLog.action, kind), eq(attentionLog.spends, true), gte(attentionLog.createdAt, new Date(now.getTime() - BUDGET_WINDOW_MS))))
  return rows.map(row => row.at)
}

function view(state: ReturnType<typeof budgetState>): BudgetView {
  return state.open ? { open: true, remaining: state.remaining } : { open: false, nextAt: state.nextAt.toISOString() }
}

/** Both budgets as they stand, for the Coordinator and the settings API. */
export async function attentionBudgets(userId: string, now = new Date()) {
  return {
    enabled: await attentionEnabled(userId),
    handoff: view(budgetState('handoff', await spends(db, userId, 'handoff', now), now)),
    notify: view(budgetState('notify', await spends(db, userId, 'notify', now), now)),
  }
}

/**
 * How many times the Coordinator told the person about a matter in the notify
 * budget's window (the last 24 hours), and the cap: the same count the budget
 * checks, for 提醒 in Settings.
 */
export async function notifiedToday(userId: string, now = new Date()): Promise<{ notified: number; limit: number }> {
  return { notified: (await spends(db, userId, 'notify', now)).length, limit: BUDGETS.notify.limit }
}

function log(tx: Tx, matter: Pick<Matter, 'id' | 'userId'>, action: (typeof attentionLog.$inferInsert)['action'], spendsBudget: boolean, extra: { reason?: string | null; runAt?: Date | null } = {}) {
  return tx.insert(attentionLog).values({ id: randomUUID(), userId: matter.userId, matterId: matter.id, action, spends: spendsBudget, reason: extra.reason ?? null, runAt: extra.runAt ?? null })
}

async function lastDecision(tx: Tx, matterId: string): Promise<HandoffPayload['previous']> {
  const [row] = await tx.select({ action: attentionLog.action, reason: attentionLog.reason }).from(attentionLog)
    .where(and(eq(attentionLog.matterId, matterId), inArray(attentionLog.action, ['notify', 'quiet', 'snooze', 'handled']))).orderBy(desc(attentionLog.createdAt)).limit(1)
  if (!row) return null
  const state: AttentionMatterState = row.action === 'notify' ? 'notified' : row.action === 'snooze' ? 'snoozed' : row.action === 'handled' ? 'handled' : 'quiet'
  return { state, reason: row.reason }
}

/**
 * Hands the next waiting matter to the Coordinator, one at a time: snoozes
 * that are due come back first as rechecks, a matter long in hand without a
 * decision is settled quiet, and a new handoff waits while the handoff budget
 * is closed. Returns whether a matter went over; the caller wakes the
 * Coordinator.
 */
export async function releaseAttention(userId: string, now = new Date()): Promise<boolean> {
  return db.transaction(async tx => {
    await lock(tx, userId)
    if (!await attentionEnabled(userId, tx)) return false
    // Only once the Coordinator read it: a handoff still in the inbox waits for the next turn.
    const delivered = sql`exists (select 1 from ${coordinatorEvents} where ${coordinatorEvents.userId} = ${userId} and ${coordinatorEvents.dedupeKey} = 'matter_handoff:' || ${attentionMatters.id} || ':' || ${attentionMatters.handoffs} and ${coordinatorEvents.deliveredAt} is not null)`
    const stale = await tx.update(attentionMatters).set({ state: 'quiet', reason: 'no decision recorded', updatedAt: now })
      .where(and(eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'handed'), lte(attentionMatters.handedAt, new Date(now.getTime() - HANDED_STALE_MS)), delivered)).returning()
    for (const matter of stale) await log(tx, matter, 'quiet', false, { reason: 'no decision recorded' })
    await tx.update(attentionMatters).set({ state: 'waiting', recheck: true, runAt: null, updatedAt: now })
      .where(and(eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'snoozed'), lte(attentionMatters.runAt, now)))
    const [inHand] = await tx.select({ id: attentionMatters.id }).from(attentionMatters).where(and(eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'handed'))).limit(1)
    if (inHand) return false
    const waiting = await tx.select().from(attentionMatters).where(and(eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'waiting'))).limit(100)
    if (!waiting.length) return false
    const handoffOpen = budgetState('handoff', await spends(tx, userId, 'handoff', now), now).open
    const matter = waiting
      .sort((a, b) => Number(b.recheck) - Number(a.recheck) || levelRank(b.level) - levelRank(a.level) || a.updatedAt.getTime() - b.updatedAt.getTime())
      .find(candidate => candidate.recheck || handoffOpen)
    if (!matter) return false
    const evidence = matter.evidence as unknown as ItemEvidence
    const payload: HandoffPayload = {
      matterId: matter.id, level: matter.level, title: matter.title, url: matter.url,
      assessment: 'cost' in matter.assessment ? matter.assessment as unknown as HandoffPayload['assessment'] : null,
      evidence,
      minutesAgo: Math.max(0, Math.round((now.getTime() - new Date(evidence.latest.occurredAt).getTime()) / 60_000)),
      recheck: matter.recheck, personAsked: matter.personAsked,
      previous: matter.handoffs ? await lastDecision(tx, matter.id) : null,
      notifyBudget: view(budgetState('notify', await spends(tx, userId, 'notify', now), now, matter.level)),
    }
    await tx.insert(coordinatorEvents).values({
      id: randomUUID(), userId, kind: 'matter_handoff',
      dedupeKey: `matter_handoff:${matter.id}:${matter.handoffs + 1}`, issueId: null, runId: null,
      payload: { ...payload }, tier: 'attention',
    }).onConflictDoNothing()
    await tx.update(attentionMatters).set({ state: 'handed', handedAt: now, handoffs: matter.handoffs + 1, recheck: false, updatedAt: now }).where(eq(attentionMatters.id, matter.id))
    await log(tx, matter, matter.recheck ? 'recheck' : 'handoff', !matter.recheck)
    return true
  })
}

export type AttentionDecision =
  | { matterId: string; decision: 'notify'; reason?: string }
  | { matterId: string; decision: 'quiet'; reason: string }
  | { matterId: string; decision: 'snooze'; reason: string; runAt: Date; personAsked?: boolean }
  | { matterId: string; decision: 'handled'; reason?: string }

export type DecisionResult = { ok: true; state: AttentionMatterState } | { error: string; nextAt?: string }

/**
 * Records the Coordinator's decision on one matter. `notify` spends the
 * notification budget (unless the person asked for the reminder) and fails
 * while it is closed, with the time it reopens; then snooze until then.
 */
export async function recordDecision(userId: string, input: AttentionDecision, now = new Date()): Promise<DecisionResult> {
  const result = await db.transaction(async (tx): Promise<{ result: DecisionResult; told?: Matter }> => {
    await lock(tx, userId)
    const [matter] = await tx.select().from(attentionMatters).where(and(eq(attentionMatters.id, input.matterId), eq(attentionMatters.userId, userId))).limit(1)
    if (!matter) return { result: { error: 'matterNotFound' } }
    const reason = input.reason?.trim() || null
    switch (input.decision) {
      case 'notify': {
        if (matter.state !== 'handed') return { result: { error: 'matterNotInHand' } }
        if (!matter.personAsked) {
          const budget = budgetState('notify', await spends(tx, userId, 'notify', now), now, matter.level)
          if (!budget.open) return { result: { error: 'notificationBudgetClosed', nextAt: budget.nextAt.toISOString() } }
        }
        await tx.update(attentionMatters).set({ state: 'notified', reason, personAsked: false, updatedAt: now }).where(eq(attentionMatters.id, matter.id))
        await log(tx, matter, 'notify', !matter.personAsked, { reason })
        return { result: { ok: true, state: 'notified' }, told: matter }
      }
      case 'quiet':
        if (matter.state !== 'handed') return { result: { error: 'matterNotInHand' } }
        await tx.update(attentionMatters).set({ state: 'quiet', reason, updatedAt: now }).where(eq(attentionMatters.id, matter.id))
        await log(tx, matter, 'quiet', false, { reason })
        return { result: { ok: true, state: 'quiet' } }
      case 'snooze':
        if (input.runAt.getTime() <= now.getTime()) return { result: { error: 'runAtNotInFuture' } }
        await tx.update(attentionMatters).set({ state: 'snoozed', reason, runAt: input.runAt, personAsked: input.personAsked ?? matter.personAsked, updatedAt: now }).where(eq(attentionMatters.id, matter.id))
        await log(tx, matter, 'snooze', false, { reason, runAt: input.runAt })
        return { result: { ok: true, state: 'snoozed' } }
      case 'handled':
        await tx.update(attentionMatters).set({ state: 'handled', reason, runAt: null, personAsked: false, updatedAt: now }).where(eq(attentionMatters.id, matter.id))
        await log(tx, matter, 'handled', false, { reason })
        return { result: { ok: true, state: 'handled' } }
    }
  })
  if (result.told) await onPersonTold(result.told)
  // The next waiting matter can go over now; the running turn takes it in its next round.
  if ('ok' in result.result) await releaseAttention(userId, now)
  return result.result
}

/**
 * After a turn: a matter it was handed but did not decide on is settled. A
 * visible reply to a turn that held only handoffs told the person, so it
 * counts as notify. Otherwise a matter the person must act on is snoozed
 * until the notification budget reopens when it is closed, and quiet
 * when it is open (when unsure, quiet).
 */
export async function settleTurn(userId: string, matterIds: readonly string[], toldPerson: boolean, now = new Date()): Promise<void> {
  if (!matterIds.length) return
  const told: Matter[] = []
  await db.transaction(async tx => {
    await lock(tx, userId)
    const open = await tx.select().from(attentionMatters).where(and(eq(attentionMatters.userId, userId), inArray(attentionMatters.id, [...matterIds]), eq(attentionMatters.state, 'handed')))
    for (const matter of open) {
      const budget = budgetState('notify', await spends(tx, userId, 'notify', now), now, matter.level)
      if (toldPerson) {
        await tx.update(attentionMatters).set({ state: 'notified', reason: 'told without recording', personAsked: false, updatedAt: now }).where(eq(attentionMatters.id, matter.id))
        await log(tx, matter, 'notify', !matter.personAsked, { reason: 'told without recording' })
        told.push(matter)
      } else if (!budget.open && (matter.level === 'critical' || matter.level === 'high')) {
        await tx.update(attentionMatters).set({ state: 'snoozed', reason: 'notification budget closed', runAt: budget.nextAt, updatedAt: now }).where(eq(attentionMatters.id, matter.id))
        await log(tx, matter, 'snooze', false, { reason: 'notification budget closed', runAt: budget.nextAt })
      } else {
        await tx.update(attentionMatters).set({ state: 'quiet', reason: 'no decision recorded', updatedAt: now }).where(eq(attentionMatters.id, matter.id))
        await log(tx, matter, 'quiet', false, { reason: 'no decision recorded' })
      }
    }
  })
  for (const matter of told) await onPersonTold(matter)
  await releaseAttention(userId, now)
}
