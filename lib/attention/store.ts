import 'server-only'
import { and, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { attentionLog, attentionMatters, attentionSettings, coordinatorEvents, type AttentionMatterState } from '@/lib/db/schema'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { BUDGET_WINDOW_MS, BUDGETS, budgetState, type BudgetKind } from './budget'
import { mergeEvidence, notice, stateAfterNotice, type BudgetView, type HandoffPayload, type ItemEvidence } from './handoff'
import { interruptInput, interruptQuestions, nextHandoffInput, nextHandoffQuestions, readInterrupt, readNextHandoff, readSettle, settleInput, settleQuestions, UNDECIDED_RETRY_MS, type MatterBrief, type NotifyHistory } from './interrupt'
import type { DecisionAnswer, DecisionQuestion } from '@/lib/coordinator/decision'
import type { MatterContext } from './judgment'
import { onPersonTold } from './push'
import type { Score } from './score'

// The person's matters from connected apps, their two budgets and the
// Coordinator's decisions (R-20). Ingest records a notice on its matter; a
// matter the Decisions API said to hand over waits until the handoff budget allows it and no
// other matter is in the Coordinator's hands, then goes over as a hidden
// `matter_handoff` event. The Coordinator records notify, quiet, snooze or
// handled with record_attention. Nothing is dropped: a matter that cannot go
// over now keeps waiting.

/** Recent matters the judgment may link a notice to. */
const MATTERS_FOR_JUDGMENT = 10
const MATTERS_DAYS = 60
/** A matter in the Coordinator's hands this long without a decision is settled by the Decisions API, so the next one can go over. */
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

/**
 * Records a notice on its matter: the thread's own matter, else the earlier
 * matter the judgment linked, else a new one when the Decisions API said
 * `handOver`. The matter takes the level the API gave this notice.
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
    const now = new Date()
    if (!target) {
      if (!score.handOver) return false
      await tx.insert(attentionMatters).values({
        id: randomUUID(), userId, matterKey, source: notification.source, suggestionId, title: notification.title, url: notification.url,
        level: score.level, assessment: { ...score.assessment }, evidence: { ...mergeEvidence(null, notice(notification), matterKey) }, state: 'waiting',
      }).onConflictDoNothing()
      return true
    }
    const next = stateAfterNotice(target, score.handOver)
    await tx.update(attentionMatters).set({
      suggestionId, url: notification.url ?? target.url, level: score.level,
      // A judgment without an assessment keeps the earlier one.
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

type Answers = ReadonlyMap<string, Exclude<DecisionAnswer, { type: 'refusal' }>>
/** One Decisions API call for the person, billed to their execution workspace. Null when it gives no answer. */
export type AttentionDecide = (userId: string, purpose: string, input: string, questions: DecisionQuestion[]) => Promise<Answers | null>
const decisionsCall: AttentionDecide = async (userId, purpose, input, questions) => {
  const [{ decide }, { hostedBillingScope }, { executionWorkspace }] = await Promise.all([import('@/lib/coordinator/decide'), import('@/lib/abuse/context'), import('@/lib/execution-settings')])
  try { return await hostedBillingScope.run({ workspaceId: await executionWorkspace(userId, null), ownerId: userId }, () => decide(purpose, input, questions)) } catch { return null }
}

function brief(matter: Matter, now: Date): MatterBrief {
  return { id: matter.id, title: matter.title, level: matter.level, reason: matter.reason, personAsked: matter.personAsked, recheck: matter.recheck, minutesWaiting: Math.max(0, Math.round((now.getTime() - matter.updatedAt.getTime()) / 60_000)) }
}

async function notifyHistory(executor: Pick<typeof db, 'select'>, userId: string, now: Date): Promise<NotifyHistory> {
  const told = (await spends(executor, userId, 'notify', now)).sort((a, b) => b.getTime() - a.getTime())
  return { today: told.length, minutesSinceLast: told.length ? Math.round((now.getTime() - told[0].getTime()) / 60_000) : null }
}

/** The Decisions API's settlement for matters the Coordinator left undecided; no answer snoozes it to be asked again. */
async function settlements(userId: string, matters: readonly Matter[], now: Date, call: AttentionDecide) {
  const notified = await notifyHistory(db, userId, now)
  return Promise.all(matters.map(async matter => {
    const answers = await call(userId, 'attention-settle', settleInput(brief(matter, now), notified, now), settleQuestions())
    const settled = answers && readSettle(answers, now)
    return { matter, settled: settled ?? { state: 'snoozed' as const, runAt: new Date(now.getTime() + UNDECIDED_RETRY_MS) }, reason: settled ? 'no decision recorded' : 'decision unavailable' }
  }))
}

async function applySettlement(tx: Tx, item: Awaited<ReturnType<typeof settlements>>[number], now: Date) {
  const { matter, settled, reason } = item
  if (settled.state === 'quiet') {
    await tx.update(attentionMatters).set({ state: 'quiet', reason, updatedAt: now }).where(and(eq(attentionMatters.id, matter.id), eq(attentionMatters.state, 'handed')))
    await log(tx, matter, 'quiet', false, { reason })
  } else {
    await tx.update(attentionMatters).set({ state: 'snoozed', reason, runAt: settled.runAt, updatedAt: now }).where(and(eq(attentionMatters.id, matter.id), eq(attentionMatters.state, 'handed')))
    await log(tx, matter, 'snooze', false, { reason, runAt: settled.runAt })
  }
}

/**
 * Hands the next waiting matter to the Coordinator, one at a time. Snoozes
 * that are due come back as rechecks; a matter long in the Coordinator's hands
 * without a decision is settled by the Decisions API; then the Decisions API
 * picks which waiting matter, if any, goes over now (it reads how many were
 * handed and told today). No answer hands nothing; the next wake asks again.
 * Only the runaway handoff cap stays in code. Model calls run outside the
 * transactions. Returns whether a matter went over; the caller wakes the Coordinator.
 */
export async function releaseAttention(userId: string, now = new Date(), call: AttentionDecide = decisionsCall): Promise<boolean> {
  if (!await attentionEnabled(userId)) return false
  // Only once the Coordinator read it: a handoff still in the inbox waits for the next turn.
  const delivered = sql`exists (select 1 from ${coordinatorEvents} where ${coordinatorEvents.userId} = ${userId} and ${coordinatorEvents.dedupeKey} = 'matter_handoff:' || ${attentionMatters.id} || ':' || ${attentionMatters.handoffs} and ${coordinatorEvents.deliveredAt} is not null)`
  const stale = await db.select().from(attentionMatters)
    .where(and(eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'handed'), lte(attentionMatters.handedAt, new Date(now.getTime() - HANDED_STALE_MS)), delivered))
  const settled = stale.length ? await settlements(userId, stale, now, call) : []
  const waiting = await db.transaction(async tx => {
    await lock(tx, userId)
    for (const item of settled) await applySettlement(tx, item, now)
    await tx.update(attentionMatters).set({ state: 'waiting', recheck: true, runAt: null, updatedAt: now })
      .where(and(eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'snoozed'), lte(attentionMatters.runAt, now)))
    const [inHand] = await tx.select({ id: attentionMatters.id }).from(attentionMatters).where(and(eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'handed'))).limit(1)
    if (inHand) return []
    return tx.select().from(attentionMatters).where(and(eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'waiting'))).orderBy(attentionMatters.updatedAt).limit(20)
  })
  if (!waiting.length) return false
  const handed = await spends(db, userId, 'handoff', now)
  if (!budgetState('handoff', handed, now).open) return false
  const briefs = waiting.map(matter => brief(matter, now))
  const answers = await call(userId, 'attention-next', nextHandoffInput(briefs, handed.length, await notifyHistory(db, userId, now), now), nextHandoffQuestions(briefs))
  const pick = answers && readNextHandoff(answers, briefs)
  if (!pick || pick === 'none') return false
  // Matters from connected apps enter the person's Coordinator chat: its bot row is resolved here, before the transaction.
  // App connections belong to the account and a matter names no workspace, so it is the personal workspace's Coordinator.
  const { botId } = await (await import('@/lib/coordinator/coordinator-bot')).coordinatorBot(userId, null)
  return db.transaction(async tx => {
    await lock(tx, userId)
    if (!await attentionEnabled(userId, tx)) return false
    const [inHand] = await tx.select({ id: attentionMatters.id }).from(attentionMatters).where(and(eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'handed'))).limit(1)
    if (inHand) return false
    const [matter] = await tx.select().from(attentionMatters).where(and(eq(attentionMatters.id, pick), eq(attentionMatters.userId, userId), eq(attentionMatters.state, 'waiting'))).limit(1)
    if (!matter || !budgetState('handoff', await spends(tx, userId, 'handoff', now), now).open) return false
    const evidence = matter.evidence as unknown as ItemEvidence
    const payload: HandoffPayload = {
      matterId: matter.id, level: matter.level, title: matter.title, url: matter.url,
      assessment: 'cost' in matter.assessment ? matter.assessment as unknown as HandoffPayload['assessment'] : null,
      evidence,
      minutesAgo: Math.max(0, Math.round((now.getTime() - new Date(evidence.latest.occurredAt).getTime()) / 60_000)),
      recheck: matter.recheck, personAsked: matter.personAsked,
      previous: matter.handoffs ? await lastDecision(tx, matter.id) : null,
      notified: await notifyHistory(tx, userId, now),
    }
    await tx.insert(coordinatorEvents).values({
      id: randomUUID(), userId, botId, kind: 'matter_handoff',
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
 * Records the Coordinator's decision on one matter. Before `notify`, the
 * Decisions API decides whether the person is interrupted now, reading how
 * often they were told today; a no fails with the time to look again (then
 * snooze until then). No answer leaves the Coordinator's own call standing,
 * logged as a fallback. A reminder the person asked for is not asked about.
 * Only the runaway notify cap stays in code.
 */
export async function recordDecision(userId: string, input: AttentionDecision, now = new Date(), call: AttentionDecide = decisionsCall): Promise<DecisionResult> {
  let declined: Date | null = null
  if (input.decision === 'notify') {
    const [matter] = await db.select().from(attentionMatters).where(and(eq(attentionMatters.id, input.matterId), eq(attentionMatters.userId, userId))).limit(1)
    if (matter?.state === 'handed' && !matter.personAsked) {
      const answers = await call(userId, 'attention-interrupt', interruptInput(brief(matter, now), await notifyHistory(db, userId, now), now), interruptQuestions())
      const verdict = answers && readInterrupt(answers, now)
      if (!verdict) console.warn('Attention interrupt fallback: the Coordinator\'s notify stands without a Decisions answer', { matterId: matter.id })
      else if (!verdict.interrupt) declined = verdict.retryAt
    }
  }
  const result = await db.transaction(async (tx): Promise<{ result: DecisionResult; told?: Matter }> => {
    await lock(tx, userId)
    const [matter] = await tx.select().from(attentionMatters).where(and(eq(attentionMatters.id, input.matterId), eq(attentionMatters.userId, userId))).limit(1)
    if (!matter) return { result: { error: 'matterNotFound' } }
    const reason = input.reason?.trim() || null
    switch (input.decision) {
      case 'notify': {
        if (matter.state !== 'handed') return { result: { error: 'matterNotInHand' } }
        if (declined && !matter.personAsked) return { result: { error: 'notifyDeclined', nextAt: declined.toISOString() } }
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
  if ('ok' in result.result) await releaseAttention(userId, now, call)
  return result.result
}

/**
 * After a turn: a matter it was handed but did not decide on is settled. A
 * visible reply to a turn that held only handoffs told the person, so it
 * counts as notify. Otherwise the Decisions API decides quiet or snooze (and
 * until when); no answer snoozes it to be asked again.
 */
export async function settleTurn(userId: string, matterIds: readonly string[], toldPerson: boolean, now = new Date(), call: AttentionDecide = decisionsCall): Promise<void> {
  if (!matterIds.length) return
  const open = await db.select().from(attentionMatters).where(and(eq(attentionMatters.userId, userId), inArray(attentionMatters.id, [...matterIds]), eq(attentionMatters.state, 'handed')))
  if (!open.length) return
  const settled = toldPerson ? [] : await settlements(userId, open, now, call)
  const told: Matter[] = []
  await db.transaction(async tx => {
    await lock(tx, userId)
    if (toldPerson) {
      for (const matter of open) {
        const rows = await tx.update(attentionMatters).set({ state: 'notified', reason: 'told without recording', personAsked: false, updatedAt: now }).where(and(eq(attentionMatters.id, matter.id), eq(attentionMatters.state, 'handed'))).returning({ id: attentionMatters.id })
        if (!rows.length) continue
        await log(tx, matter, 'notify', !matter.personAsked, { reason: 'told without recording' })
        told.push(matter)
      }
    } else for (const item of settled) await applySettlement(tx, item, now)
  })
  for (const matter of told) await onPersonTold(matter)
  await releaseAttention(userId, now, call)
}
