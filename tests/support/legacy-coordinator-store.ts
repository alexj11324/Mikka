/** Historical SQL fixtures only. Production runtime state is owned by eve. */
import { captureRunFailure, readRunFailure, type RunFailure } from '@mikka/protocol/run-failure'
import { APP_BUILD } from '@/lib/app-build'
import { sourcedEventMessage } from '@/lib/coordinator/message-safety'
import { runCompletionObservations } from '@/lib/coordinator/run-completion-observation'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { credentialMasker, maskCredentials, maskDeep } from '@/lib/secrets/mask'
import 'server-only'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm'
import type { ModelMessage } from 'ai'
import { db } from '@/lib/db'
import { coordinatorSessionChanged } from '@/lib/live/coordinator-session'
import { wakeTokens, wakeWorkflowAfterCommit } from '@/lib/workflow-wake'
import { wakeCoordinatorSoon } from '@/lib/coordinator/wake-after-commit'
import { COORDINATOR_LEASE_CHANNEL } from '@/lib/db/listen'
import { coordinatorEvents, coordinatorMessages, coordinatorSessions } from '@/lib/db/schema'
import { markTelegramPending, pendingTelegramTargets, type PendingTelegramTarget } from '@/lib/coordinator/telegram-pending'
import { eventPrompt } from '@/lib/coordinator/context'
import { eventsForInbox, isolateTaskRequest } from '@/lib/coordinator/triage'
import { attentionQuestionsFromEvents, type AttentionQuestion } from '@/lib/coordinator/question-attention'
import { coordinatorLeaseActive } from '@/lib/coordinator/lease'
import type { InboxEvent } from '@/lib/push-reasons'
import type { ScheduledRead } from '@/lib/schedules/contract'
import { scheduledInbox, type Occurrence } from '@/lib/schedules/store'
import { botChatChanged } from '@/lib/live/chats'
import type { CoordinatorStartupReceipt, CoordinatorStartupSettingsCandidate, CoordinatorStartupSettings, CoordinatorStartupTake } from './legacy-coordinator-startup'

export * from '@/lib/coordinator/store'

const LEASE_MS = 10 * 60_000
const INBOX_BATCH = 50
type Executor = Pick<typeof db, 'select' | 'insert' | 'execute'>
const sessionOf = (userId: string, botId: string) => and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.botId, botId))
const messagesOf = (userId: string, botId: string) => and(eq(coordinatorMessages.userId, userId), eq(coordinatorMessages.botId, botId))
const eventsOf = (userId: string, botId: string) => and(eq(coordinatorEvents.userId, userId), eq(coordinatorEvents.botId, botId))

async function nextPosition(executor: Executor, userId: string, botId: string): Promise<number> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-chat:${userId}:${botId}`},0))`)
  const [row] = await executor.select({ last: sql<number>`coalesce(max(${coordinatorMessages.position}), 0)` })
    .from(coordinatorMessages).where(messagesOf(userId, botId))
  return Number(row?.last ?? 0) + 1
}

/** Direct user input is deliverable without a classifier. Other events need
 * a classification; a missing runtime judgment remains pending. */
const wakingEvent = and(isNull(coordinatorEvents.deliveredAt), or(eq(coordinatorEvents.kind, 'user_message'), and(isNotNull(coordinatorEvents.tier), ne(coordinatorEvents.tier, 'background'))))
function waking(userId: string, botId: string) {
  return and(eventsOf(userId, botId), wakingEvent)
}

/** Whether any undelivered event should start a turn in this chat. */
export async function hasWakingEvents(userId: string, botId: string): Promise<boolean> {
  const [row] = await db.select({ id: coordinatorEvents.id }).from(coordinatorEvents).where(waking(userId, botId)).limit(1)
  return Boolean(row)
}

/** Any undelivered, non-background row of this chat, triaged or not. */
export async function hasPendingEvents(userId: string, botId: string): Promise<boolean> {
  const [row] = await db.select({ id: coordinatorEvents.id }).from(coordinatorEvents).where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt), or(isNull(coordinatorEvents.tier), ne(coordinatorEvents.tier, 'background')))).limit(1)
  return Boolean(row)
}


/**
 * Takes the lease for `holder` (or renews it) and moves undelivered inbox
 * events into the conversation as user messages. Background events ride along
 * with runtime notifications, never direct user input. With nothing else waiting, nothing moves. `held` is false
 * when another turn holds the lease; that turn will pick the events up.
 */
export interface InboxTake {
  held: boolean
  added: number
  telegramTargets: PendingTelegramTarget[]
  /** Matters from connected apps handed over in this take (lib/attention). */
  handoffMatterIds: string[]
  /** Every event in the take is a handoff: a reply can only be telling the person about one. */
  handoffOnly: boolean
  /** The events the reply answers; the Decisions API decides whether it goes to the person's phones (lib/push-reasons.ts). */
  pushEvents: InboxEvent[]
  /** A handed-over verification code: the push says only that one came, the code stays in the app chat. */
  pushHidesText: boolean
  taskEventId?: string
  sourceEventId?: string
  /** Durable human handoffs already chosen by this inbox's Decision receipts. */
  attentionQuestions?: AttentionQuestion[]
  scheduledRead?: ScheduledRead
}

const NO_TAKE = { added: 0, telegramTargets: [], handoffMatterIds: [], handoffOnly: false, pushEvents: [], pushHidesText: false }

export async function takeInbox(userId: string, holder: string, botId: string): Promise<InboxTake> {
  return (await takeInboxTransaction(userId, holder, botId)).inbox
}

/** A bounded ordinary round zero commits a receipt before combined preparation.
 * Other new takes retain the inbox-only durable boundary. Existing receipts
 * always replay first; every attempt checks the lease and gains no authority. */
export async function takeStartupInbox(userId: string, holder: string, botId: string, candidate: CoordinatorStartupSettingsCandidate): Promise<CoordinatorStartupTake> {
  const codec = await import('./legacy-coordinator-startup')
  // Reject a missing or malformed candidate before any session/lease write;
  // an unchecked JS caller must never fall through to a legacy take.
  const result = await takeInboxTransaction(userId, holder, botId, codec.startupSettingsCandidate(candidate))
  if (!result.startup) throw codec.startupReceiptConflict(new Error('coordinatorStartupReceiptMissing'))
  return result.startup
}

type InboxTransactionResult = { inbox: InboxTake; startup?: CoordinatorStartupTake }
/** SQL-only transport tuple: version and the two compact stored objects.
 * The storage codec restores and checks the strict canonical receipt. */
type StoredStartupReceipt = [unknown, unknown, unknown]
type StartupEventRow = Omit<typeof coordinatorEvents.$inferSelect, 'id' | 'createdAt' | 'deliveredAt' | 'lastTriageAttemptAt' | 'nextWakeAt' | 'wakeLeaseUntil'> & {
  id: string | null; createdAt: string | Date; deliveredAt: string | Date | null;
  lastTriageAttemptAt: string | Date | null; nextWakeAt: string | Date; wakeLeaseUntil: string | Date | null;
  r: StoredStartupReceipt | null;
}
type TimestampDecoder = Pick<typeof coordinatorSessions.leaseUntil, 'mapFromDriverValue'>
function startupTimestamp(column: TimestampDecoder, value: string | Date): Date
function startupTimestamp(column: TimestampDecoder, value: string | Date | null): Date | null
function startupTimestamp(column: TimestampDecoder, value: string | Date | null): Date | null {
  // Drizzle's raw node-postgres execute path retains timestamp strings. Use
  // the same column decoder as select(), including its timezone semantics.
  return value === null || value instanceof Date ? value : column.mapFromDriverValue(value) as Date
}
async function takeInboxTransaction(userId: string, holder: string, botId: string, candidate?: CoordinatorStartupSettingsCandidate): Promise<InboxTransactionResult> {
  // Legacy takes do not load the new receipt decoder or change their SQL graph.
  const codec = candidate ? await import('./legacy-coordinator-startup') : null
  const frozenCandidate = candidate ?? null
  const rollbackLost = new Error('coordinatorStartupLeaseLost')
  let lost: InboxTransactionResult | undefined
  try { return await db.transaction(async tx => {
    const now = new Date()
    await tx.insert(coordinatorSessions).values({ userId, botId }).onConflictDoNothing()
    let previousLease: { leaseHolder: string | null; leaseUntil: Date | null } | undefined
    let taken: boolean
    let settings: CoordinatorStartupSettings | undefined
    let startupRows: StartupEventRow[] | undefined
    if (codec && frozenCandidate) {
      // The locked row, including an EPQ-updated tuple after a concurrent
      // holder commits, supplies the acquisition predicate and old holder.
      // A single result column avoids four RowDescription fields. Tuple order
      // is previous holder, previous expiry, acquired, Coordinator marker.
      const lease = (await tx.execute(sql`WITH previous AS MATERIALIZED(SELECT "userId" u,"botId" b,"leaseHolder" h,"leaseUntil" t FROM coordinator_sessions WHERE "userId"=${userId} AND "botId"=${botId}::uuid FOR UPDATE),acquired AS(UPDATE coordinator_sessions s SET "leaseHolder"=v.h,"leaseUntil"=v.e,"updatedAt"=v.n FROM previous p,(VALUES(${holder}::text,${new Date(now.getTime() + LEASE_MS)}::timestamptz,${now}::timestamptz))v(h,e,n) WHERE (s."userId",s."botId")=(p.u,p.b) AND(p.t IS NULL OR p.t<v.n OR p.h=v.h) RETURNING 1) SELECT jsonb_build_array(p.h,p.t,EXISTS(SELECT 1 FROM acquired),EXISTS(SELECT 1 FROM coordinator_bots c WHERE(c."ownerId",c."botId")=(p.u,p.b))) l FROM previous p`)).rows[0]?.l as [string | null, string | Date | null, boolean, boolean] | undefined
      previousLease = lease && { leaseHolder: lease[0], leaseUntil: startupTimestamp(coordinatorSessions.leaseUntil, lease[1]) }
      taken = lease?.[2] === true
      settings = { ...frozenCandidate, coordinator: lease?.[3] === true }
      // This MUST be a new statement after the lock. A same-key waiter must
      // see the winner's committed receipt, not its pre-lock snapshot.
      let stored: StoredStartupReceipt | null | undefined
      if (!taken) {
        // A competing lease cannot take events. Still check the old key after
        // the lock, without returning seventeen unused event column headers.
        stored = (await tx.execute(sql`SELECT jsonb_build_array(version,settings,inbox) r FROM coordinator_startup_receipts WHERE("userId","botId",holder,round)=(${userId},${botId}::uuid,${holder},0)`)).rows[0]?.r as StoredStartupReceipt | undefined
      } else {
        startupRows = (await tx.execute(sql`SELECT CASE WHEN r.holder IS NOT NULL THEN jsonb_build_array(r.version,r.settings,r.inbox) END r,e.* FROM(VALUES(${userId}::text,${botId}::uuid,${holder}::text))k(u,b,h) LEFT JOIN coordinator_startup_receipts r ON(r."userId",r."botId",r.holder,r.round)=(k.u,k.b,k.h,0) LEFT JOIN coordinator_events e ON r.holder IS NULL AND(e."userId",e."botId")=(k.u,k.b) AND e."deliveredAt" IS NULL AND(e.kind='user_message' OR(e.tier IS NOT NULL AND e.tier<>'background')) WHERE r.holder IS NOT NULL OR e.id IS NOT NULL ORDER BY e."createdAt" LIMIT ${INBOX_BATCH}`)).rows as typeof startupRows
        stored = startupRows?.[0]?.r
      }
      if (stored !== null && stored !== undefined) {
        // Presence comes from the row key, never the stored inbox's truthiness.
        const receipt = codec.decodeStoredStartupReceipt(stored[0], stored[1], stored[2])
        if (!taken || previousLease?.leaseHolder !== holder) {
          // Stop/release/new holder is terminal for this old key. Roll back
          // even an otherwise eligible temporary claim, before any callbacks.
          lost = { inbox: receipt.inbox, startup: { kind: 'lost', ...receipt, replayed: true } }
          throw rollbackLost
        }
        if (!coordinatorLeaseActive(previousLease, now)) {
          await botChatChanged(tx, userId, botId)
          await tx.execute(sql`SELECT pg_notify(${COORDINATOR_LEASE_CHANNEL}, ${botId})`)
        }
        await coordinatorSessionChanged(tx, userId, botId)
        return { inbox: receipt.inbox, startup: { kind: 'ready', ...receipt, replayed: true } }
      }
    } else {
      ;[previousLease] = await tx.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil })
        .from(coordinatorSessions).where(sessionOf(userId, botId)).for('update')
      const rows = await tx.update(coordinatorSessions)
        .set({ leaseHolder: holder, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
        .where(and(sessionOf(userId, botId), or(isNull(coordinatorSessions.leaseUntil), lt(coordinatorSessions.leaseUntil, now), eq(coordinatorSessions.leaseHolder, holder))))
        .returning({ userId: coordinatorSessions.userId })
      taken = rows.length > 0
    }
    if (!taken) {
      const inbox = { held: false, ...NO_TAKE }
      return { inbox, ...(codec ? { startup: { kind: 'not-held' as const, inbox } } : {}) }
    }
    const finish = async (inbox: InboxTake): Promise<InboxTransactionResult> => {
      if (!codec || !settings) return { inbox }
      const receipt = codec.readStartupReceipt(1, settings, inbox)
      const stored = codec.encodeStoredStartupReceipt(receipt)
      const storedSettings = JSON.stringify(stored.settings), storedInbox = JSON.stringify(stored.inbox)
      // Only a small ordinary inbox needs a receipt for preparation inside
      // this step. Larger/new non-combined takes return their complete inbox
      // directly at the original durable boundary, with no fallible work
      // after COMMIT. Existing receipts were replayed above before this choice.
      if (inbox.added > 0 && (inbox.scheduledRead || !settings.agentKitEnabled ||
        Buffer.byteLength(storedSettings, 'utf8') + Buffer.byteLength(storedInbox, 'utf8') > 256)) {
        return { inbox: receipt.inbox, startup: { kind: 'inbox-only', ...receipt } }
      }
      const inserted = await tx.execute(sql`INSERT INTO coordinator_startup_receipts("userId","botId",holder,round,version,settings,inbox) VALUES(${userId},${botId}::uuid,${holder},0,1,${storedSettings}::jsonb,${storedInbox}::jsonb) ON CONFLICT("userId","botId",holder,round) DO NOTHING`)
      if (inserted.rowCount !== 1) throw codec.startupReceiptConflict(new Error('coordinatorStartupReceiptConflict'))
      return { inbox: receipt.inbox, startup: { kind: 'ready', ...receipt, replayed: false } }
    }
    // Ordinary renewal is not a broad list update. Only a new/changed turn
    // or actual message delivery changes the summary that the sidebar shows.
    if (!coordinatorLeaseActive(previousLease, now) || previousLease?.leaseHolder !== holder) {
      await botChatChanged(tx, userId, botId)
      // 停止 for a turn that is about to start waits on this (stop-turn.ts); delivered on COMMIT.
      await tx.execute(sql`SELECT pg_notify(${COORDINATOR_LEASE_CHANNEL}, ${botId})`)
    }
    await coordinatorSessionChanged(tx, userId, botId)
    // A receipt-only LEFT JOIN row has no event. It must never reach
    // payload/source handling; empty seed rows are filtered in SQL already.
    const candidates = startupRows ? startupRows.flatMap(row => {
      if (row.id === null) return []
      const { r: _receipt, ...event } = row
      return [{ ...event, id: row.id,
        createdAt: startupTimestamp(coordinatorEvents.createdAt, row.createdAt),
        deliveredAt: startupTimestamp(coordinatorEvents.deliveredAt, row.deliveredAt),
        lastTriageAttemptAt: startupTimestamp(coordinatorEvents.lastTriageAttemptAt, row.lastTriageAttemptAt),
        nextWakeAt: startupTimestamp(coordinatorEvents.nextWakeAt, row.nextWakeAt),
        wakeLeaseUntil: startupTimestamp(coordinatorEvents.wakeLeaseUntil, row.wakeLeaseUntil),
      }]
    }) : await tx.select().from(coordinatorEvents).where(waking(userId, botId))
      .orderBy(asc(coordinatorEvents.createdAt)).limit(INBOX_BATCH)
    // A schedule is a separate read-only turn. Hydrate its authority through
    // the stored event link, never from notification/model payload fields.
    const scheduledCandidate = candidates[0]?.payload.source === 'schedule_due' ? candidates[0] : undefined
    const scheduledRow=scheduledCandidate?(await tx.execute(sql`SELECT o.* FROM schedule_occurrences o JOIN user_schedules s ON s.id=o.schedule_id WHERE o.event_id=${scheduledCandidate.id} AND s.owner_id=${userId} AND s.bot_id=${botId}::uuid LIMIT 1`)).rows[0] as (Omit<Occurrence,'lease_until'> & {lease_until:string|Date|null})|undefined:undefined
    // This shared legacy/startup read is raw Drizzle too. Decode its expiry
    // before the schedule guard; a missing/non-finite lease grants no scope.
    const scheduledUntil=scheduledRow?startupTimestamp(coordinatorSessions.leaseUntil,scheduledRow.lease_until):null
    const scheduled=!scheduledRow?.event_id?null:!scheduledUntil||!Number.isFinite(scheduledUntil.getTime())
      ?{eventId:scheduledRow.event_id,scope:null}:scheduledInbox({...scheduledRow,lease_until:scheduledUntil},now)
    if(scheduled && !scheduled.scope){
      await tx.update(coordinatorEvents).set({deliveredAt:now,tier:'background'}).where(eq(coordinatorEvents.id,scheduled.eventId))
      return finish({held:true,...NO_TAKE})
    }
    const scheduledRead=scheduled?.scope??undefined
    const eligible = candidates.filter(event => event.payload.source !== 'schedule_due' || event.id === scheduledCandidate?.id)
    // Keep pending human corrections together, without runtime notifications in their turn.
    const direct = eligible.filter(event => event.kind === 'user_message')
    let due = scheduledRead ? [scheduledCandidate!] : isolateTaskRequest(direct.length ? direct : eligible)
    if (!due.length) return finish({ held: true, ...NO_TAKE })
    let taskEventId = due.length === 1 && due[0].kind === 'user_message' && due[0].payload.taskDestination !== undefined ? due[0].id : undefined
    const source = due.findLast(event => event.kind === 'user_message' && event.payload.postedToChat !== true)
      ?? due.findLast(event => event.kind === 'user_message')
    let sourceEventId = scheduled ? undefined : source?.id
    if (!scheduled && source?.payload.retry === true && source.payload.postedToChat === true) {
      // A retry is a wake, not another human request. Resolve server-written
      // provenance on the last actual person message, within this owned chat.
      const [original] = await tx.select({ id: coordinatorEvents.id, payload: coordinatorEvents.payload }).from(coordinatorMessages)
        .innerJoin(coordinatorEvents, and(eventsOf(userId, botId), eq(coordinatorEvents.kind, 'user_message'),
          isNotNull(coordinatorEvents.deliveredAt), sql`${coordinatorEvents.id}::text = ${coordinatorMessages.message}->'mikkaUserEvent'->>'id'`))
        .where(and(messagesOf(userId, botId), sql`${coordinatorMessages.message}->>'role' = 'user'`)).orderBy(desc(coordinatorMessages.position)).limit(1)
      if (original) {
        sourceEventId = original.id
        if (original.payload.taskDestination !== undefined) { taskEventId = original.id; due = [source] }
      }
    }
    const isolatedTask = Boolean(taskEventId) || Boolean(scheduled)
    const backgroundLimit = isolatedTask || due.some(event => event.kind === 'user_message') ? 0 : INBOX_BATCH - due.length
    const background = backgroundLimit ? await tx.select().from(coordinatorEvents)
      .where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt), notInArray(coordinatorEvents.id, due.map(event => event.id)), eq(coordinatorEvents.tier, 'background')))
      .orderBy(asc(coordinatorEvents.createdAt)).limit(backgroundLimit) : []
    const events = eventsForInbox(due, background, INBOX_BATCH)
    if (!events.length) return finish({ held: true, ...NO_TAKE })
    const chatEvents = events.filter(event => !(event.kind === 'user_message' && event.payload.postedToChat === true))
    const completionObservations = await runCompletionObservations(tx, { userId, botId }, chatEvents)
    const first = await nextPosition(tx, userId, botId)
    if (chatEvents.length) await tx.insert(coordinatorMessages).values(chatEvents.map((event, index) => ({
      id: crypto.randomUUID(), userId, botId, position: first + index,
      // A GitHub or other token in an event (a run's summary, a tool's text) never reaches the chat.
      message: maskDeep(sourcedEventMessage({ ...event, deliveredAt: now }, scheduledRead ? `[Scheduled read-only task] The person requested this stored task for now: ${scheduledRead.prompt}\nUse only the available allowed read tools. Do not create or change anything, request approval, schedule more work, or claim an external write. Return the result for this original chat.` : eventPrompt(event, event.runId ? completionObservations.get(event.runId) : undefined)), credentialMasker),
    })))
    if (chatEvents.length) await botChatChanged(tx, userId, botId)
    await tx.update(coordinatorEvents).set({ deliveredAt: now }).where(inArray(coordinatorEvents.id, events.map(event => event.id)))
    for (const event of events) {
      const payload = markTelegramPending(event)
      if (payload) await tx.update(coordinatorEvents).set({ payload }).where(eq(coordinatorEvents.id, event.id))
    }
    // A failed model turn has already consumed its inbox. Persisted source
    // receipts keep its destination available to the next successful turn.
    const pendingReplies = await tx.select().from(coordinatorEvents)
      .where(and(eventsOf(userId, botId), isNotNull(coordinatorEvents.deliveredAt), sql`${coordinatorEvents.payload}->'mikkaTelegramReply'->>'state' = 'pending'`))
      .orderBy(asc(coordinatorEvents.createdAt), asc(coordinatorEvents.id)).limit(100)
    const handoffs = events.filter(event => isHandoff(event.kind))
    const attentionQuestions = scheduledRead ? [] : attentionQuestionsFromEvents(events)
    return finish({
      held: true, added: events.length,
      ...(taskEventId ? { taskEventId } : {}),
      ...(sourceEventId ? { sourceEventId } : {}),
      ...(scheduledRead ? { scheduledRead } : {}),
      ...(attentionQuestions.length ? { attentionQuestions } : {}),
      // A verification code is told in the app chat only, never on Telegram.
      telegramTargets: handoffs.some(carriesCode) ? [] : pendingTelegramTargets(pendingReplies),
      handoffMatterIds: handoffs.flatMap(event => typeof event.payload.matterId === 'string' ? [event.payload.matterId] : []),
      handoffOnly: handoffs.length === events.length,
      pushEvents: events.map(event => ({ kind: event.kind, tier: event.tier, runId: event.runId, issueId: event.issueId })),
      pushHidesText: handoffs.some(carriesCode),
    })
  }) } catch (error) {
    if (error === rollbackLost && lost) return lost
    throw error
  }
}

function isHandoff(kind: string): boolean {
  return kind === 'matter_handoff'
}

/** Terminal-failure context only: no take, lease renewal or authorization
 * snapshot. The execution cleanup separately rechecks current membership. */
export async function recoverStartupInbox(userId: string, holder: string, botId: string): Promise<CoordinatorStartupReceipt | null> {
  const row = (await db.execute(sql`SELECT r.version, r.settings, r.inbox FROM coordinator_startup_receipts r
    JOIN bots b ON b.id=r."botId" AND b."ownerId"=${userId}
    WHERE r."userId"=${userId} AND r."botId"=${botId}::uuid AND r.holder=${holder} AND r.round=0`)).rows[0]
  if (!row) return null
  const { decodeStoredStartupReceipt } = await import('./legacy-coordinator-startup')
  return decodeStoredStartupReceipt(row.version, row.settings, row.inbox)
}

function carriesCode(event: { payload: Record<string, unknown> }): boolean {
  const assessment = event.payload.assessment
  return Boolean(assessment && typeof assessment === 'object' && (assessment as { verificationCode?: unknown }).verificationCode)
}

/** Lets go of the lease. Returns whether events that need a turn arrived meanwhile, so the caller can take them. */
export async function releaseLease(userId: string, holder: string, botId: string): Promise<boolean> {
  const released = await db.update(coordinatorSessions).set({ leaseHolder: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(sessionOf(userId, botId), eq(coordinatorSessions.leaseHolder, holder))).returning({ userId: coordinatorSessions.userId })
  if (released.length) await botChatChanged(db, userId, botId)
  if (released.length) await coordinatorSessionChanged(db, userId, botId)
  // A wake deadline waiting behind this lease rechecks now, not at the lease's old expiry (#1212).
  if (released.length) wakeWorkflowAfterCommit(db, wakeTokens.coordinatorWake(userId, botId))
  const waking = await hasWakingEvents(userId, botId)
  // Rows written during the turn that triage has not seen (tier NULL, not a
  // user message) are not this loop's to take; their writer's wake deferred
  // behind this lease, so wake again now that it is free (#1212).
  if (released.length && !waking && await hasPendingEvents(userId, botId)) wakeCoordinatorSoon(userId)
  return waking
}


export async function lastEventKind(userId: string, botId: string): Promise<string | null> {
  const [last] = await db.select({ kind: sql<string | null>`${coordinatorMessages.message}->'mikkaEvent'->>'eventKind'` })
    .from(coordinatorMessages).where(messagesOf(userId, botId)).orderBy(desc(coordinatorMessages.position)).limit(1)
  return last?.kind ?? null
}

export async function appendMessages(userId: string, holder: string, unmasked: ModelMessage[], warning: string | null = null, botId: string, streamId?: string, stopped = false): Promise<number> {
  return appendStoredMessages(userId, holder, unmasked, warning, botId, streamId, stopped, false)
}

/** Only a trusted host producer may persist display/source envelopes. */
export async function appendHostMessages(userId: string, holder: string, messages: import('@/lib/coordinator/message-safety').SourcedMessage[], botId: string): Promise<number> {
  return appendStoredMessages(userId, holder, messages, null, botId, undefined, false, true)
}

async function appendStoredMessages(userId: string, holder: string, unmasked: ModelMessage[], warning: string | null, botId: string, streamId: string | undefined, stopped: boolean, hostPresentation: boolean): Promise<number> {
  // Safety floor (decision 2026-11-02-1600): a GitHub token or other credential
  // never persists in chat, a tool result included.
  const messages = maskDeep(unmasked, credentialMasker)
  await assertCredentialSafeChat(userId, messages)
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT 1 FROM coordinator_sessions WHERE "userId"=${userId} AND "botId"=${botId}::uuid FOR UPDATE`)
    const first = await nextPosition(tx, userId, botId)
    if (messages.length) {
      await tx.insert(coordinatorMessages).values(messages.map((message, index) => {
        const { mikkaStreamId: _untrusted, mikkaStopped: _unmarked, mikkaFailure: _unfailed, mikkaFailureDetails: _details, mikkaRetried: _unretried, mikkaScheduleResult: _unscheduled, mikkaDisplay, mikkaEvent, mikkaUserEvent, ...plain } = message as unknown as Record<string, unknown>
        // 停止: the turn's last message carries the mark; the chat shows 已停止 under the reply.
        const stop = stopped && index === messages.length - 1 && message.role === 'assistant'
        return { id: crypto.randomUUID(), userId, botId, position: first + index,
          message: { ...plain, ...(hostPresentation ? { mikkaDisplay, mikkaEvent, mikkaUserEvent } : {}), ...(message.role === 'assistant' && streamId ? { mikkaStreamId: streamId } : {}), ...(stop ? { mikkaStopped: true } : {}) } }
      }))
      await botChatChanged(tx, userId, botId)
    }
    const now = new Date()
    const renewed = await tx.update(coordinatorSessions).set({ leaseUntil: new Date(now.getTime() + LEASE_MS), lastError: warning && maskCredentials(warning), lastErrorAt: warning ? now : null, lastFailure: warning ? captureRunFailure(new Error(warning), { runId: holder, appVersion: APP_BUILD }) : null, updatedAt: now })
      .where(and(sessionOf(userId, botId), eq(coordinatorSessions.leaseHolder, holder))).returning({ userId: coordinatorSessions.userId })
    if (messages.length || renewed.length) await coordinatorSessionChanged(tx, userId, botId)
    return first + messages.length - 1
  })
}


/**
 * Records why a turn failed and lets go of the lease. The person's message the
 * turn was answering keeps the reason too (`mikkaFailure`), so the chat shows it
 * under that message after the next turn and after a reload.
 */
export async function failTurn(userId: string, holder: string, error: string, botId: string, completed?: { messages: ModelMessage[]; streamId: string }, failureDetails?: RunFailure): Promise<void> {
  const reason = maskCredentials(error).slice(0, 1000)
  const failure = readRunFailure(maskDeep(captureRunFailure(failureDetails ? { failureDetails } : new Error(reason), { runId: holder, appVersion: APP_BUILD }), credentialMasker))
  const messages = completed ? maskDeep(completed.messages, credentialMasker) : []
  if (messages.length) await assertCredentialSafeChat(userId, messages)
  await db.transaction(async tx => {
    const released = await tx.update(coordinatorSessions).set({ leaseHolder: null, leaseUntil: null, lastError: reason, lastErrorAt: new Date(), lastFailure: failure, updatedAt: new Date() })
      .where(and(sessionOf(userId, botId), eq(coordinatorSessions.leaseHolder, holder))).returning({ userId: coordinatorSessions.userId })
    if (!released.length) return
    await botChatChanged(tx, userId, botId)
    await coordinatorSessionChanged(tx, userId, botId)
    wakeWorkflowAfterCommit(tx, wakeTokens.coordinatorWake(userId, botId))
    await tx.execute(sql`UPDATE coordinator_messages SET message = message || jsonb_build_object('mikkaFailure', ${reason}::text, 'mikkaFailureDetails', ${JSON.stringify(failure)}::jsonb)
      WHERE "userId"=${userId} AND "botId"=${botId}::uuid AND message->>'role'='user'
        AND position=(SELECT max(position) FROM coordinator_messages WHERE "userId"=${userId} AND "botId"=${botId}::uuid)`)
    // A bounded tool-recovery failure can follow real completed tool effects.
    // Keep their receipts and the invalid-call evidence in the same transaction
    // as the failure/lease release. A replay no longer owns the lease and
    // returns above, so it cannot duplicate these messages or their effects.
    if (messages.length) {
      const first = await nextPosition(tx, userId, botId)
      await tx.insert(coordinatorMessages).values(messages.map((message, index) => {
        const { mikkaStreamId: _untrusted, mikkaStopped: _unmarked, mikkaFailure: _unfailed, mikkaFailureDetails: _details, mikkaRetried: _unretried, mikkaScheduleResult: _unscheduled, mikkaDisplay: _display, mikkaEvent: _event, mikkaUserEvent: _user, ...plain } = message as unknown as Record<string, unknown>
        return { id: crypto.randomUUID(), userId, botId, position: first + index,
          message: { ...plain, ...(message.role === 'assistant' && completed?.streamId ? { mikkaStreamId: completed.streamId } : {}) } }
      }))
    }
  })
}
