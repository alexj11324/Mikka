import { chatProjectionHash } from './chat-projection-version'
import { captureRunFailure, readRunFailure, type RunFailure } from '@mikka/protocol/run-failure'
import { APP_BUILD } from '@/lib/app-build'
import { sourcedEventMessage } from './message-safety'
import { runCompletionObservations } from './run-completion-observation'
import { visibleRuns } from '@/lib/agent-runs'
import { threadNamePrompt } from '@/lib/run-bot-name'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { credentialMasker, maskCredentials, maskDeep } from '@/lib/secrets/mask'
import { issuesForUser } from '@/lib/issues-for-user'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import 'server-only'
import { COORDINATOR_WELCOME_MARK } from '@/lib/agent-welcome'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm'
import type { ModelMessage } from 'ai'
import { db } from '@/lib/db'
import { coordinatorSessionChanged } from '@/lib/live/coordinator-session'
import { wakeTokens, wakeWorkflowAfterCommit } from '@/lib/workflow-wake'
import { wakeCoordinatorSoon } from './wake-after-commit'
import { COORDINATOR_LEASE_CHANNEL } from '@/lib/db/listen'
import { agentRuns, agents, bots, coordinatorEvents, coordinatorMessages, coordinatorSessions, issueMembers, issues, runChunks, type CoordinatorEventTier } from '@/lib/db/schema'
import { markTelegramPending, pendingTelegramTargets, type PendingTelegramTarget } from './telegram-pending'
import { chatItems, eventPrompt, type ChatItem, type StoredMessage } from '@/lib/coordinator/context'
import { eventsForInbox, isolateTaskRequest } from '@/lib/coordinator/triage'
import { attentionQuestionsFromEvents, type AttentionQuestion } from './question-attention'
import { citedIds, namedCitations, type CitationName, type CitationSource } from '@/lib/coordinator/citations'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { threadGroup, type ThreadOutcome } from '@/lib/thread-groups'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { artifactSummaries, type ArtifactSummary } from '@/lib/artifacts/store'
import { runSummaryText } from '@/lib/issue-run-conversation'
import { threadName } from '@/lib/issue-threads'
import { coordinatorChatState } from './chat-state'
import { compactChatMessage, compactChatToolMetadata, summaryChatMessage } from './chat-projection'
import type { ChatToolMetadata, ChatToolMetadataRow } from './chat-tool-metadata'
import { coordinatorLeaseActive } from './lease'
import { readCoordinatorPromptPreferences, readPreferences } from '@/lib/preferences'
import type { InboxEvent } from '@/lib/push-reasons'
import { TRIAGE_RETRY_COOLDOWN_MS } from './triage-batch'
import type { TriageJudgment } from './triage-batch'
import type { DecisionExecution } from './decide'
import type { ScheduledRead } from '@/lib/schedules/contract'
import { scheduledInbox, type Occurrence } from '@/lib/schedules/store'
import { botChatChanged } from '../live/chats'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { activeTaskWorkspaces, requireTaskWorkspace } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'
import type { CoordinatorStartupReceipt, CoordinatorStartupSettingsCandidate, CoordinatorStartupSettings, CoordinatorStartupTake } from './startup-receipt'

// The Coordinator's conversation in Neon. A turn takes the lease, moves the
// inbox into the conversation, answers, and lets go; a wake that finds the
// lease taken leaves its events for the turn that holds it.

/** How long a turn may hold the lease before another wake may take over. */
const LEASE_MS = 10 * 60_000
/** Inbox events moved into the conversation per take. */
const INBOX_BATCH = 50

type Executor = Pick<typeof db, 'select' | 'insert' | 'execute'>

// Every bot chats on this harness, the Coordinator included (it is a bot row,
// lib/coordinator/coordinator-bot.ts). `botId` picks the chat; each chat has
// its own conversation, memory, inbox and lease.
const sessionOf = (userId: string, botId: string) => and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.botId, botId))
const messagesOf = (userId: string, botId: string) => and(eq(coordinatorMessages.userId, userId), eq(coordinatorMessages.botId, botId))
const eventsOf = (userId: string, botId: string) => and(eq(coordinatorEvents.userId, userId), eq(coordinatorEvents.botId, botId))

async function chatReader(userId: string, botId: string): Promise<IssueReader> {
  const [bot] = await db.select({ workspaceId: bots.workspaceId }).from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, userId))).limit(1)
  if (!bot) throw new ActionFailureError('botNotFound')
  await requireTaskWorkspace(userId, bot.workspaceId)
  return { id: userId, [tokenWorkspace]: bot.workspaceId }
}

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

/** The person's chats (the Coordinator's among them) with events that should start a turn. */
export async function wakingChats(userId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ botId: coordinatorEvents.botId }).from(coordinatorEvents).where(and(eq(coordinatorEvents.userId, userId), isNotNull(coordinatorEvents.botId), isNull(coordinatorEvents.deliveredAt), or(isNull(coordinatorEvents.tier), ne(coordinatorEvents.tier, 'background'))))
  return rows.flatMap(row => row.botId ? [row.botId] : [])
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
  const codec = await import('./startup-receipt')
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
  const codec = candidate ? await import('./startup-receipt') : null
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
  const { decodeStoredStartupReceipt } = await import('./startup-receipt')
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

/** Direct user delivery first. Runtime ordering uses the last attempt, falling
 * back to original creation time. Trying a slow event advances the durable
 * cursor instead of repeatedly hiding all events after the oldest batch. */
export async function untriagedEvents(userId: string, botId: string) {
  const reader = await chatReader(userId, botId)
  const retryBefore = new Date(Date.now() - TRIAGE_RETRY_COOLDOWN_MS)
  const events = await db.select().from(coordinatorEvents)
    .where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt), isNull(coordinatorEvents.tier),
      or(eq(coordinatorEvents.kind, 'user_message'), isNull(coordinatorEvents.lastTriageAttemptAt), lt(coordinatorEvents.lastTriageAttemptAt, retryBefore))))
    .orderBy(desc(eq(coordinatorEvents.kind, 'user_message')), asc(sql`coalesce(${coordinatorEvents.lastTriageAttemptAt}, ${coordinatorEvents.createdAt})`), asc(coordinatorEvents.id)).limit(INBOX_BATCH)
  const runIds = [...new Set(events.flatMap(event => event.runId ? [event.runId] : []))]
  // Reuse the existing visibility gate; teammate projections stay restricted.
  const observed = new Map((runIds.length ? await visibleRuns(reader, { runIds, limit: runIds.length, brief: true }) : [])
    .map(run => [run.id, { id: run.id, status: run.status, finishedAt: run.finishedAt }]))
  return events.map(event => ({ ...event, observedRun: event.runId ? observed.get(event.runId) ?? null : null }))
}

export async function setEventTier(id: string, tier: CoordinatorEventTier, scope: { userId: string; botId: string }): Promise<boolean> {
  const applied = await db.update(coordinatorEvents).set({ tier }).where(and(eq(coordinatorEvents.id, id), isNull(coordinatorEvents.deliveredAt), isNull(coordinatorEvents.tier), eventsOf(scope.userId, scope.botId))).returning({ id: coordinatorEvents.id })
  if (applied.length) await botChatChanged(db, scope.userId, scope.botId)
  return applied.length === 1
}

type TriageEventRecord = typeof coordinatorEvents.$inferSelect
export async function claimTriageAttempt(event: TriageEventRecord, scope: { userId: string; botId: string }): Promise<Date | null> {
  const now = new Date(), retryBefore = new Date(now.getTime() - TRIAGE_RETRY_COOLDOWN_MS)
  const [claimed] = await db.update(coordinatorEvents).set({ lastTriageAttemptAt: now })
    .where(and(eventsOf(scope.userId, scope.botId), eq(coordinatorEvents.id, event.id), ne(coordinatorEvents.kind, 'user_message'),
      isNull(coordinatorEvents.deliveredAt), isNull(coordinatorEvents.tier),
      event.lastTriageAttemptAt ? sql`date_trunc('milliseconds', ${coordinatorEvents.lastTriageAttemptAt}) = ${event.lastTriageAttemptAt}` : isNull(coordinatorEvents.lastTriageAttemptAt),
      or(isNull(coordinatorEvents.lastTriageAttemptAt), lt(coordinatorEvents.lastTriageAttemptAt, retryBefore))))
    .returning({ attemptedAt: coordinatorEvents.lastTriageAttemptAt })
  return claimed?.attemptedAt ?? null
}

/** Winning attempt and the exact event payload must still match. Persisting the
 * actual host receipt with the tier does not turn that choice into permission. */
export async function completeTriageAttempt(event: TriageEventRecord & { observedRun?: unknown }, scope: { userId: string; botId: string }, attemptedAt: Date, judgment: TriageJudgment & { tier: CoordinatorEventTier; execution: DecisionExecution }): Promise<boolean> {
  const receipt = { version: 1, method: 'model', eventId: event.id, eventKind: event.kind,
    attemptedAt: attemptedAt.toISOString(), chosenTier: judgment.tier, observedRun: event.observedRun ?? null, execution: judgment.execution }
  const applied = await db.update(coordinatorEvents).set({ tier: judgment.tier, triageDecision: receipt })
    .where(and(eventsOf(scope.userId, scope.botId), eq(coordinatorEvents.id, event.id), eq(coordinatorEvents.kind, event.kind),
      event.runId ? eq(coordinatorEvents.runId, event.runId) : isNull(coordinatorEvents.runId),
      event.issueId ? eq(coordinatorEvents.issueId, event.issueId) : isNull(coordinatorEvents.issueId),
      // pg Date values expose milliseconds, whereas default now() can contain
      // microseconds. Compare the same observable precision, not a rounded
      // parameter against the full timestamp (which would reject real events).
      sql`date_trunc('milliseconds', ${coordinatorEvents.createdAt}) = ${event.createdAt}`,
      eq(coordinatorEvents.payload, event.payload), eq(coordinatorEvents.lastTriageAttemptAt, attemptedAt),
      isNull(coordinatorEvents.deliveredAt), isNull(coordinatorEvents.tier)))
    .returning({ id: coordinatorEvents.id })
  if (applied.length) await botChatChanged(db, scope.userId, scope.botId)
  return applied.length === 1
}

/**
 * Appends the turn's new messages and renews the lease. `warning` says why the
 * reply may be cut short; it shows in the chat until a turn ends cleanly.
 */
/** The kind of host event the last stored message records (lib/coordinator/message-safety.ts), or null. */
export async function lastEventKind(userId: string, botId: string): Promise<string | null> {
  const [last] = await db.select({ kind: sql<string | null>`${coordinatorMessages.message}->'mikkaEvent'->>'eventKind'` })
    .from(coordinatorMessages).where(messagesOf(userId, botId)).orderBy(desc(coordinatorMessages.position)).limit(1)
  return last?.kind ?? null
}

export async function appendMessages(userId: string, holder: string, unmasked: ModelMessage[], warning: string | null = null, botId: string, streamId?: string, stopped = false): Promise<number> {
  // Safety floor (decision 2026-11-02-1600): a GitHub token or other credential
  // never persists in chat, a tool result included.
  const messages = maskDeep(unmasked, credentialMasker)
  await assertCredentialSafeChat(userId, messages)
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT 1 FROM coordinator_sessions WHERE "userId"=${userId} AND "botId"=${botId}::uuid FOR UPDATE`)
    const first = await nextPosition(tx, userId, botId)
    if (messages.length) {
      await tx.insert(coordinatorMessages).values(messages.map((message, index) => {
        const { mikkaStreamId: _untrusted, mikkaStopped: _unmarked, mikkaFailure: _unfailed, mikkaFailureDetails: _details, mikkaRetried: _unretried, ...plain } = message as unknown as Record<string, unknown>
        // 停止: the turn's last message carries the mark; the chat shows 已停止 under the reply.
        const stop = stopped && index === messages.length - 1 && message.role === 'assistant'
        return { id: crypto.randomUUID(), userId, botId, position: first + index,
          message: { ...plain, ...(message.role === 'assistant' && streamId ? { mikkaStreamId: streamId } : {}), ...(stop ? { mikkaStopped: true } : {}) } }
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
 * 重试 on a failed reply: runs the same turn again over the conversation as it
 * stands, so the person's message is not sent twice. The event never becomes a
 * chat message, and one failure can be retried once; a new failure can be
 * retried again. A turn that ended with no reply and no recorded error (its
 * lease ran out) counts as failed too. False when nothing failed or a turn is
 * already running.
 */
export async function retryFailedTurn(userId: string, botId: string): Promise<boolean> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT 1 FROM coordinator_sessions WHERE "userId"=${userId} AND "botId"=${botId}::uuid FOR UPDATE`)
    const [session] = await tx.select().from(coordinatorSessions).where(sessionOf(userId, botId)).limit(1)
    if (!session || coordinatorLeaseActive(session)) return false
    // A recorded failure, or a turn that ended with neither a reply nor an error (its lease ran out):
    // the person's message is the newest one, so nothing answered it.
    let failure = session.lastError && session.lastErrorAt ? session.lastErrorAt.toISOString() : null
    if (!failure) {
      const [last] = await tx.select({ position: coordinatorMessages.position, role: sql<string>`${coordinatorMessages.message}->>'role'` })
        .from(coordinatorMessages).where(messagesOf(userId, botId)).orderBy(desc(coordinatorMessages.position)).limit(1)
      const waiting = await tx.select({ id: coordinatorEvents.id }).from(coordinatorEvents).where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt))).limit(1)
      if (last?.role === 'user' && !waiting.length) failure = `unanswered:${last.position}`
    }
    if (!failure) return false
    const inserted = await tx.insert(coordinatorEvents).values({
      id: crypto.randomUUID(), userId, botId, kind: 'user_message', issueId: null, runId: null,
      dedupeKey: `turn_retry:${userId}:${botId}:${failure}`,
      payload: { text: '', postedToChat: true, retry: true },
    }).onConflictDoNothing({ target: coordinatorEvents.dedupeKey }).returning({ id: coordinatorEvents.id })
    if (inserted.length) await botChatChanged(tx, userId, botId)
    return inserted.length === 1
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
        const { mikkaStreamId: _untrusted, mikkaStopped: _unmarked, mikkaFailure: _unfailed, mikkaFailureDetails: _details, mikkaRetried: _unretried, ...plain } = message as unknown as Record<string, unknown>
        return { id: crypto.randomUUID(), userId, botId, position: first + index,
          message: { ...plain, ...(message.role === 'assistant' && completed?.streamId ? { mikkaStreamId: completed.streamId } : {}) } }
      }))
    }
  })
}

/**
 * 重新发送 on a failed message: marks it retried (`mikkaRetried`) and sends its
 * text again in one transaction, so the chat and the model's history keep only
 * the new attempt. The mark is set only on this person's own user message in
 * this chat that carries a failure; any other position is ignored and the send
 * goes ahead as an ordinary message, saying nothing about what that position
 * holds. The message and its failure stay stored. A message already retried
 * (a double click, two sends at once) sends nothing more: null.
 */
export async function sendRetryOf<T>(userId: string, botId: string, position: number, send: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>): Promise<T | null> {
  return db.transaction(async tx => {
    const target = sql`"userId"=${userId} AND "botId"=${botId}::uuid AND position=${position} AND message->>'role'='user' AND message ? 'mikkaFailure'`
    // The row lock makes a second send wait, then find the mark and stop.
    const marked = await tx.execute(sql`UPDATE coordinator_messages SET message = message || '{"mikkaRetried":true}'::jsonb
      WHERE ${target} AND NOT message ? 'mikkaRetried' RETURNING position`)
    if (!marked.rows.length && (await tx.execute(sql`SELECT 1 FROM coordinator_messages WHERE ${target} AND message ? 'mikkaRetried'`)).rows.length) return null
    return send(tx)
  })
}

/** The summary so far, the memory, and every message after the summary, oldest first. */
type LoadedConversation = { summary: string | null; memory: string; messages: StoredMessage[] }

async function readConversationRows(userId: string, botId: string) {
  const [session] = await db.select().from(coordinatorSessions).where(sessionOf(userId, botId)).limit(1)
  const through = session?.summaryThrough ?? 0
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message })
    .from(coordinatorMessages)
    .where(and(messagesOf(userId, botId), gt(coordinatorMessages.position, through)))
    .orderBy(asc(coordinatorMessages.position))
  return { session, rows }
}

function conversationWithMemory({ session, rows }: Awaited<ReturnType<typeof readConversationRows>>, memoryEnabled: boolean): LoadedConversation {
  // 使用记忆 off (the app's 记忆 setting): the prompt leaves the memory out; it stays saved.
  const memory = memoryEnabled ? session?.memory ?? '' : ''
  // A failed message retried with 重新发送 is not said twice: the new attempt stands for it.
  return { summary: session?.summary ?? null, memory, messages: rows.filter(row => (row.message as { mikkaRetried?: unknown }).mikkaRetried !== true).map(row => {
    const { mikkaStreamId: _streamId, mikkaStopped: _stopped, mikkaFailure: _failure, mikkaFailureDetails: _details, mikkaRetried: _retried, ...message } = row.message
    return { position: row.position, message: message as unknown as ModelMessage }
  }) }
}

export async function loadConversation(userId: string, botId: string): Promise<LoadedConversation> {
  const conversation = await readConversationRows(userId, botId)
  return conversationWithMemory(conversation, (await readPreferences(userId)).memoryEnabled)
}

/** One fresh owner-scoped preference row supplies this prompt's memory switch and personal instructions. */
export async function loadConversationForPrompt(userId: string, botId: string): Promise<LoadedConversation & { personalInstructions: string }> {
  const [conversation, preferences] = await Promise.allSettled([
    readConversationRows(userId, botId),
    readCoordinatorPromptPreferences(userId),
  ])
  // Observe both reads before returning to turn cleanup. Keep the original
  // conversation-first failure precedence and the original error objects.
  if (conversation.status === 'rejected') throw conversation.reason
  if (preferences.status === 'rejected') throw preferences.reason
  return {
    ...conversationWithMemory(conversation.value, preferences.value.memoryEnabled),
    personalInstructions: preferences.value.personalInstructions,
  }
}

/** Replaces every message at or before `through` with `summary`. The messages stay stored. */
export async function saveSummary(userId: string, summary: string, through: number, botId: string): Promise<void> {
  await db.update(coordinatorSessions).set({ summary, summaryThrough: through, updatedAt: new Date() })
    .where(sessionOf(userId, botId))
}

/** Rewrites the memory with `edit`, under a row lock so two edits do not lose each other. */
export async function editMemory<T>(userId: string, edit: (memory: string) => { memory: string; result: T } | { error: string }, botId: string): Promise<T | { error: string }> {
  return db.transaction(async tx => {
    await tx.insert(coordinatorSessions).values({ userId, botId }).onConflictDoNothing()
    const [session] = await tx.select({ memory: coordinatorSessions.memory }).from(coordinatorSessions)
      .where(sessionOf(userId, botId)).for('update')
    const outcome = edit(session?.memory ?? '')
    if ('error' in outcome) return outcome
    // A credential never persists in memory.
    await tx.update(coordinatorSessions).set({ memory: maskCredentials(outcome.memory), updatedAt: new Date() }).where(sessionOf(userId, botId))
    return outcome.result
  })
}

export interface ChatView {
  items: ChatItem[]
  /** Active Workflow lease for this exact owner and bot. */
  streamRunId?: string
  /** Last stored message position, excluding pending inbox items. */
  cursor?: number
  /** Server-owned IDs already represented in these stored assistant messages. */
  persistedStreamIds?: string[]
  /** A turn is active, or pending input is new or holds its first live delivery lease. */
  working: boolean
  /** Why the last turn failed, when no turn has answered since. */
  error: string | null
  /** Under a wake code: the last turn's own stored failure, for 详情 (chat-state.ts). */
  cause?: string
  /** Safe persisted diagnostics; available without a second read. */
  failureDetails?: RunFailure
  /** The issues and runs the replies cite, by id, that this person can see. */
  sources: Record<string, CitationSource>
  /** The artifacts shown as cards, by id. */
  artifacts: Record<string, ArtifactSummary>
  continuation?: { after: number; prefix: string; cursor: number }
  /** A disk projection requests a one-time display-metadata repair. */
  restoreToolMetadata?: true
  /** Response-only, consumed before the snapshot enters SWR or persistence. */
  toolMetadata?: ChatToolMetadata
  historyBefore?: number
}

/** The reasoning text of this person's stored messages at `positions` in one chat, in order; stored messages are already masked (appendMessages). */
export async function storedReasoning(userId: string, botId: string, positions: readonly number[]): Promise<string[]> {
  await chatReader(userId, botId)
  if (!positions.length) return []
  const rows = await db.select({ message: coordinatorMessages.message }).from(coordinatorMessages)
    .where(and(messagesOf(userId, botId), inArray(coordinatorMessages.position, [...positions]))).orderBy(asc(coordinatorMessages.position))
  return rows.flatMap(({ message }) => message.role === 'assistant' && Array.isArray(message.content)
    ? (message.content as { type?: unknown; text?: unknown }[]).flatMap(part => part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim() ? [part.text] : [])
    : [])
}

/** Looks up the issues and runs cited in `texts`, and the `threads` dispatched, keeping only what `userId` may see. */
export async function citationSources(reader: IssueReader, texts: readonly string[], threads: readonly string[] = []): Promise<Record<string, CitationSource>> {
  const userId = typeof reader === 'string' ? reader : reader.id
  const cited = citedIds(texts)
  const issueIds = cited.issueIds
  const runIds = [...new Set([...cited.runIds, ...threads])]
  const sources: Record<string, CitationSource> = {}
  if (!issueIds.length && !runIds.length) return sources
  // Authorization reads keep the complete principal and fresh workspace gate.
  // Numbering is a separate bounded read after the visible tasks are known.
  const visibility = issueIds.length
    ? await issueVisibility(reader, false, undefined, db, { onlyIssueIds: issueIds, withTeamLinks: false }) : null
  const issueRows = issueIds.length ? await db.select({ id: issues.id, ownerId: issues.userId, scope: issues.scope, title: issues.title, status: issues.status, priority: issues.priority, content: issueAttrsContent })
    .from(issues)
    .where(and(inArray(issues.id, issueIds), visibility!.predicate)) : []
  // Each visible cited task's newest thread, for its one state (localTaskState). Only its status and outcome, under
  // the task branch of the run visibility rule (runVisibilityPredicate): the run in the task's own workspace, inside
  // the reader's workspaces, on a task the same predicate shows.
  const visibleIssueIds = issueRows.map(row => row.id)
  const newestRuns = visibleIssueIds.length ? await db.selectDistinctOn([agentRuns.issueId], { issueId: agentRuns.issueId, status: agentRuns.status, outcome: agentRuns.outcome })
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .innerJoin(issues, and(eq(issues.id, agentRuns.issueId), eq(agentRuns.workspaceId, issues.workspaceId)))
    .where(and(inArray(agentRuns.issueId, visibleIssueIds), visibility!.workspaceIds.length ? inArray(agentRuns.workspaceId, visibility!.workspaceIds) : sql`false`, visibility!.predicate))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id)) : []
  const newestRun = new Map(newestRuns.map(row => [row.issueId, { status: row.status, outcome: row.outcome ?? null }]))
  // Only what a citation shows: the report's summary, the prompt's opening (its name) and each task without its body.
  const runs = runIds.length ? await visibleRuns(reader, { runIds, limit: runIds.length, brief: true }) : []
  // A teammate's run arrives as the bare projection (no agent id): its prompt, report and steps stay with its owner.
  const ownIds = runs.filter(row => row.agentId).map(row => row.id)
  const runIssueIds = [...new Set(runs.flatMap(row => row.issueId ? [row.issueId] : []))]
  // The prompt and tool count belong to the same authorized owner runs. One
  // bounded projection avoids opening a third APP connection beside tasks.
  const [ownedRuns, tasks] = await Promise.all([
    ownIds.length ? db.select({ id: agentRuns.id, prompt: threadNamePrompt,
      steps: sql<number>`(select count(*) from ${runChunks} c where c."runId" = agent_runs.id
        and c.chunk->>'type' = 'tool-input-available')`.mapWith(Number),
    }).from(agentRuns).where(and(inArray(agentRuns.id, ownIds), eq(agentRuns.userId, userId))) : [],
    issuesForUser(reader, runIssueIds, false, db, { projection: 'citation', withTeamLinks: false }),
  ])
  const prompts = new Map(ownedRuns.map(row => [row.id, row.prompt]))
  const steps = new Map(ownedRuns.map(row => [row.id, row.steps]))
  // Every cited and run task's display identifier in one lookup.
  const identifiers = await taskIdentifiers([
    ...issueRows.map(row => ({ id: row.id, ownerId: row.ownerId, scope: row.scope, number: readIssueMetadata(row.content).number })),
    ...[...tasks.values()].map(task => ({ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number })),
  ], db)
  for (const { content, ownerId: _owner, scope: _scope, ...row } of issueRows) {
    const metadata = readIssueMetadata(content)
    if (!metadata.deletedAt) sources[row.id] = { kind: 'issue', ...row, number: metadata.number ?? null, identifier: identifiers.get(row.id) ?? null,
      run: newestRun.get(row.id) ?? null, pullRequests: metadata.pullRequests }
  }
  for (const row of runs) {
    const task = row.issueId ? tasks.get(row.issueId) ?? null : null
    // The short title travels only when there is one, so a citation carries nothing new otherwise.
    const shortTitle = task && task.shortTitleFrom === task.title ? task.shortTitle : null
    const issue = task ? { id: task.id, title: task.title, ...(shortTitle ? { shortTitle } : {}), number: readIssueMetadata(task.content).number ?? null, identifier: identifiers.get(task.id) ?? null, status: task.status } : null
    const pullRequests = task ? readIssueMetadata(task.content).pullRequests : []
    const group = threadGroup({ id: row.id, status: row.status, issueId: task?.id ?? null, createdAt: row.createdAt.toISOString(), outcome: (row.outcome ?? null) as ThreadOutcome | null }, task ? { status: task.status, metadata: { pullRequests } } : undefined)
    sources[row.id] = { kind: 'run', id: row.id, agentName: row.agentName, harness: row.harness, status: row.status, outcome: row.outcome ?? null, group, issue,
      pullRequests,
      name: threadName(prompts.get(row.id) ?? '', row.agentName), summary: runSummaryText(row), steps: steps.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null }
  }
  return sources
}

/**
 * What `namedCitations` writes for each cited task and thread: a task's title
 * and a thread's name, under the same visibility as `citationSources` and
 * nothing more (no identifiers, reports, steps or pull requests). The bot
 * list's preview line reads this on every poll.
 */
export async function citationNames(reader: IssueReader, texts: readonly string[]): Promise<Record<string, CitationName>> {
  const userId = typeof reader === 'string' ? reader : reader.id
  const { issueIds, runIds } = citedIds(texts)
  const names: Record<string, CitationName> = {}
  if (!issueIds.length && !runIds.length) return names
  const teams = await (await import('@/lib/team-access')).accessibleTeamScopes(userId)
  const [tasks, runs] = await Promise.all([
    issueIds.length ? (async () => db.selectDistinct({ id: issues.id, title: issues.title }).from(issues)
      .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
      .where(and(inArray(issues.id, issueIds), (await issueVisibility(reader, false, undefined, db, { onlyIssueIds: issueIds, teams })).predicate,
        sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`)))() : [],
    // Loaded here: unit tests stub agent-runs with the names the store's other callers use.
    runIds.length ? import('@/lib/agent-runs').then(runs => runs.visibleRunNames(reader, [...new Set(runIds)], teams)) : [],
  ])
  for (const task of tasks) names[task.id] = { kind: 'issue', title: task.title }
  // A teammate's thread is named by its harness, as its bare projection (workspaceRunView) is.
  for (const run of runs) names[run.id] = { kind: 'run', name: run.own ? threadName(run.promptHead ?? '', run.agentName) : threadName('', run.harness) }
  return names
}

/** A waiting message as the chat shows it: its words, and a stand-in per photo so the chat can count them. */
function withImages(text: string, images: unknown): ModelMessage['content'] {
  if (!Array.isArray(images) || !images.length) return text
  return [{ type: 'text', text }, ...images.map(() => ({ type: 'file' as const, data: '', mediaType: 'image/jpeg' }))]
}

type ChatReadObservation = { expiries: Date[]; observedAt: number }

/** Both full and version reads derive their deadline from the session/inbox they already read. */
function chatReadObservation(session: Parameters<typeof coordinatorChatState>[0], waiting: Parameters<typeof coordinatorChatState>[1], now: Date): ChatReadObservation {
  return { expiries: [
    ...(coordinatorLeaseActive(session, now) && session?.leaseUntil ? [session.leaseUntil] : []),
    ...waiting.flatMap(event => event.tier !== 'background' && event.kind !== 'matter_handoff' && event.wakeAttempts === 1 && event.wakeLeaseUntil && event.wakeLeaseUntil > now ? [event.wakeLeaseUntil] : []),
  ], observedAt: now.getTime() }
}

/** The latest of the conversation for the chat, oldest first. */
export async function chatView(userId: string, limit = 200, botId: string, window: { after?: number; through?: number } = {}): Promise<ChatView> {
  return (await chatViewState(userId, limit, botId, window)).chat
}

/** Full readers sharing the live chat cache need its deadline, without a second version/body read. */
export async function chatViewState(userId: string, limit = 200, botId: string, window: { after?: number; through?: number } = {}): Promise<{ chat: ChatView } & ChatReadObservation> {
  const reader = await chatReader(userId, botId)
  const sessionRead = db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil, lastError: coordinatorSessions.lastError, lastErrorAt: coordinatorSessions.lastErrorAt, lastFailure: coordinatorSessions.lastFailure })
    .from(coordinatorSessions).where(sessionOf(userId, botId)).limit(1).as('chat_session')
  // Compact parts: the chat never shows reasoning text or whole tool inputs and outputs (chat-projection.ts).
  const messagesRead = db.select({ id: coordinatorMessages.id, position: coordinatorMessages.position, message: compactChatMessage.as('message'), createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(and(messagesOf(userId, botId), window.after === undefined ? undefined : gt(coordinatorMessages.position, window.after), window.through === undefined ? undefined : sql`${coordinatorMessages.position} <= ${window.through}`))
    .orderBy(desc(coordinatorMessages.position)).limit(limit + 1).as('chat_messages')
  type MessageRow = { id: string; position: number; message: Record<string, unknown>; createdAt: string }
  const storedRead = db.select({ rows: sql<MessageRow[]>`coalesce(jsonb_agg(to_jsonb(${sql.identifier('chat_messages')}) order by ${messagesRead.position} desc), '[]'::jsonb)`.as('rows') })
    .from(messagesRead).as('chat_stored')
  const waitingRead = db.select({ kind: coordinatorEvents.kind, tier: coordinatorEvents.tier, wakeAttempts: coordinatorEvents.wakeAttempts,
    wakeLeaseUntil: coordinatorEvents.wakeLeaseUntil, wakeLastError: coordinatorEvents.wakeLastError, issueId: coordinatorEvents.issueId,
    runId: coordinatorEvents.runId, payload: coordinatorEvents.payload, createdAt: coordinatorEvents.createdAt }).from(coordinatorEvents)
    .where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt), window.through === undefined ? undefined : sql`false`))
    .orderBy(asc(coordinatorEvents.createdAt)).limit(INBOX_BATCH).as('chat_waiting')
  type WaitingRow = Pick<typeof coordinatorEvents.$inferSelect, 'kind' | 'tier' | 'wakeAttempts' | 'wakeLastError' | 'issueId' | 'runId' | 'payload'> & { wakeLeaseUntil: string | null; createdAt: string }
  // Claiming an inbox atomically changes all three tables. A session read from
  // before that commit with messages/inbox from after it invents a failed turn.
  // One bounded statement keeps their snapshot together without a held lock.
  const [snapshot] = await db.select({ leaseHolder: sessionRead.leaseHolder, leaseUntil: sessionRead.leaseUntil, lastError: sessionRead.lastError, lastErrorAt: sessionRead.lastErrorAt, lastFailure: sessionRead.lastFailure, rows: storedRead.rows,
    waiting: sql<WaitingRow[]>`coalesce((select jsonb_agg(to_jsonb(${sql.identifier('chat_waiting')}) order by ${waitingRead.createdAt}) from ${waitingRead}), '[]'::jsonb)`,
  }).from(storedRead).leftJoin(sessionRead, sql`true`)
  const session = { leaseHolder: snapshot.leaseHolder, leaseUntil: snapshot.leaseUntil, lastError: snapshot.lastError, lastErrorAt: snapshot.lastErrorAt, lastFailure: snapshot.lastFailure }
  const rows = snapshot.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt) }))
  const hasMore = rows.length > limit
  rows.splice(limit)
  // Events still in the inbox: the person's own messages show at once, ahead of the turn that takes them.
  const waiting = snapshot.waiting.map(event => ({ ...event, createdAt: new Date(event.createdAt), wakeLeaseUntil: event.wakeLeaseUntil ? new Date(event.wakeLeaseUntil) : null }))
  const last = rows[0]?.position ?? window.after ?? 0
  const lastMessage = rows[0] && { role: String(rows[0].message.role), ...(typeof rows[0].message.mikkaStreamId === 'string' ? { streamId: rows[0].message.mikkaStreamId } : {}), createdAt: rows[0].createdAt }
  // A retry (重试, or an interrupted turn) re-answers a message already in the chat (postedToChat): no second bubble.
  const pending = waiting.filter(event => event.kind === 'user_message' && event.payload.postedToChat !== true && !String(event.payload.text ?? '').startsWith(COORDINATOR_WELCOME_MARK)).map((event, index) => ({
    position: last + index + 1, createdAt: event.createdAt, message: { role: 'user', content: withImages(eventPrompt(event), event.payload.images) } as ModelMessage, pending: true as const,
  }))
  const read = chatItems([...rows.reverse().map(row => ({ ...row, message: row.message as unknown as ModelMessage })), ...pending])
  // An older page (history): a welcome failure there was answered by what came after it, so it is not shown.
  const items = window.through !== undefined ? read.filter(item => !item.welcome) : read
  const after = Math.max(0, (items.findLast(item => !item.pending)?.position ?? 1) - 1)
  const now = new Date()
  const chat: ChatView = {
    items,
    cursor: last,
    persistedStreamIds: [...new Set(rows.flatMap(({message}) => message.role === 'assistant' && typeof message.mikkaStreamId === 'string' ? [message.mikkaStreamId] : []))],
    ...(coordinatorLeaseActive(session) && session?.leaseHolder?.startsWith('wrun_') ? { streamRunId: session.leaseHolder } : {}),
    ...coordinatorChatState(session, waiting, now, lastMessage),
    // An event line names its thread or task as a chip (C1); its stored text is the model's, never shown.
    sources: await citationSources(reader, [...items.filter(item => item.from === 'coordinator').map(item => item.text),
      ...items.flatMap(item => item.line ? [item.line.runId && `[[run:${item.line.runId}]]`, item.line.issueId && `[[issue:${item.line.issueId}]]`].filter((text): text is string => !!text) : [])], items.flatMap(item => item.threads)),
    artifacts: await artifactSummaries(reader, items.flatMap(item => [...item.artifacts, ...(item.quote ? [item.quote.artifactId] : [])])),
    continuation: { after, prefix: await chatPrefix(userId, botId, after), cursor: last },
    ...(hasMore && rows[0] ? { historyBefore: rows[0].position } : {}),
  }
  return { chat, ...chatReadObservation(session, waiting, now) }
}

/** Hash only the bounded prefix that preceded the last rendered item; no message body crosses the wire. */
async function chatPrefix(userId: string, botId: string, through: number) {
  const rows = db.select({ id: coordinatorMessages.id, position: coordinatorMessages.position, message: coordinatorMessages.message }).from(coordinatorMessages)
    .where(and(messagesOf(userId, botId), sql`${coordinatorMessages.position} <= ${through}`)).orderBy(desc(coordinatorMessages.position)).limit(200).as('chat_prefix')
  const [result] = await db.select({ hash: sql<string>`md5(coalesce(string_agg(${rows.id}::text || ':' || md5(${rows.message}::text), ',' order by ${rows.position}), ''))` }).from(rows)
  return chatProjectionHash(result.hash)
}

/** Hash and metadata share one statement snapshot, so a concurrent prefix edit
 * cannot pair an old proof with new tool labels. Only these aggregates leave
 * PostgreSQL; the stored message is read there solely to prove the prefix. */
async function chatPrefixMetadata(userId: string, botId: string, through: number, cursor: number) {
  const rows = db.select({ id: coordinatorMessages.id, position: coordinatorMessages.position, message: coordinatorMessages.message, parts: compactChatToolMetadata.as('parts') })
    .from(coordinatorMessages).where(and(messagesOf(userId, botId), sql`${coordinatorMessages.position} <= ${through}`)).orderBy(desc(coordinatorMessages.position)).limit(200).as('chat_prefix')
  const [result] = await db.select({
    hash: sql<string>`md5(coalesce(string_agg(${rows.id}::text || ':' || md5(${rows.message}::text), ',' order by ${rows.position}), ''))`,
    rows: sql<ChatToolMetadataRow[]>`coalesce(jsonb_agg(jsonb_build_object('position', ${rows.position}, 'parts', ${rows.parts}) order by ${rows.position}) filter (where ${rows.position} >= ${Math.max(0, cursor - 199)} and jsonb_array_length(${rows.parts}) > 0), '[]'::jsonb)`,
  }).from(rows)
  return { ...result, hash: chatProjectionHash(result.hash) }
}

/** The web chat's first screen: the latest messages, older ones a page at a time
 * (`historyBefore`). Each full read transfers every message body on it. */
export const CHAT_FIRST_PAGE = 50

/** Replay the last rendered item too, so tool results and multi-step replies merge exactly as a full read. */
export async function chatUpdate(userId: string, botId: string, continuation?: NonNullable<ChatView['continuation']> & { restoreToolMetadata?: true }) {
  const prefix = continuation && continuation.after <= continuation.cursor
    ? continuation.restoreToolMetadata ? await chatPrefixMetadata(userId, botId, continuation.after, continuation.cursor)
      : { hash: await chatPrefix(userId, botId, continuation.after), rows: undefined }
    : undefined
  if (continuation && prefix && prefix.hash === continuation.prefix) {
    const latest = await chatVersion(userId, 200, botId)
    if (continuation.cursor <= latest.cursor) {
      const tail = await chatView(userId, 200, botId, { after: continuation.after })
      // A reconnect after a long absence must not silently skip a window of messages.
      // The tail carries its own coherent state. The earlier version read may
      // predate an inbox claim and must not overwrite a now-running tail.
      if (!tail.historyBefore) return { ...tail, after: continuation.after, baseCursor: continuation.cursor,
        ...(prefix.rows ? { toolMetadata: { baseCursor: continuation.cursor, prefix: continuation.prefix, rows: prefix.rows } } : {}) }
    }
  }
  return chatView(userId, CHAT_FIRST_PAGE, botId)
}

/** What a chat poll needs to know without reading the conversation: its version and live state. */
export interface ChatVersion {
  /** Changes whenever the chat's stored messages (the latest `limit`) or its waiting inbox change. */
  version: string
  cursor: number
  streamRunId?: string
  working: boolean
  error: string | null
  cause?: string
}

/** The version plus when `working` changes with no write: the active turn's or a first wake's lease runs out. */
export type ChatVersionState = ChatVersion & ChatReadObservation

/**
 * The chat's version, computed in the database from the same latest `limit`
 * messages `chatView` shows (a hash of each message), plus its waiting inbox
 * and state. Only a few dozen bytes leave the database, where `chatView`
 * sends the messages themselves.
 */
export async function chatVersion(userId: string, limit = 200, botId: string): Promise<ChatVersion> {
  const { expiries: _expiries, observedAt: _observedAt, ...version } = await chatVersionState(userId, limit, botId)
  return version
}

export async function chatVersionState(userId: string, limit = 200, botId: string): Promise<ChatVersionState> {
  await chatReader(userId, botId)
  const sessionRead = db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil, lastError: coordinatorSessions.lastError, lastErrorAt: coordinatorSessions.lastErrorAt, failureVersion: sql<string>`md5(coalesce(${coordinatorSessions.lastFailure}::text, ''))`.as('failureVersion') })
    .from(coordinatorSessions).where(sessionOf(userId, botId)).limit(1).as('chat_session')
  const latest = db.select({ id: coordinatorMessages.id, position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(messagesOf(userId, botId)).orderBy(desc(coordinatorMessages.position)).limit(limit).as('latest')
  const storedRead = db.select({
    last: sql<number>`coalesce(max(${latest.position}), 0)::int`.as('last'),
    hash: sql<string>`md5(coalesce(string_agg(${latest.id}::text || ':' || md5(${latest.message}::text), ',' order by ${latest.position}), ''))`.as('hash'),
    role: sql<string | null>`(array_agg(${latest.message}->>'role' order by ${latest.position} desc))[1]`.as('role'),
    streamId: sql<string | null>`(array_agg(${latest.message}->>'mikkaStreamId' order by ${latest.position} desc))[1]`.as('streamId'),
    createdAt: sql<string | null>`(array_agg(${latest.createdAt} order by ${latest.position} desc))[1]`.as('createdAt'),
  }).from(latest).as('chat_stored')
  const waitingRead = db.select({ id: coordinatorEvents.id, payloadVersion: sql<string>`md5(${coordinatorEvents.payload}::text)`.as('payloadVersion'), kind: coordinatorEvents.kind, tier: coordinatorEvents.tier, wakeAttempts: coordinatorEvents.wakeAttempts, wakeLeaseUntil: coordinatorEvents.wakeLeaseUntil, wakeLastError: coordinatorEvents.wakeLastError, createdAt: coordinatorEvents.createdAt }).from(coordinatorEvents)
    .where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt)))
    .orderBy(asc(coordinatorEvents.createdAt)).limit(INBOX_BATCH).as('chat_waiting')
  type WaitingRow = Pick<typeof coordinatorEvents.$inferSelect, 'id' | 'kind' | 'tier' | 'wakeAttempts' | 'wakeLastError'> & { payloadVersion: string; wakeLeaseUntil: string | null; createdAt: string }
  const [snapshot] = await db.select({ leaseHolder: sessionRead.leaseHolder, leaseUntil: sessionRead.leaseUntil, lastError: sessionRead.lastError, lastErrorAt: sessionRead.lastErrorAt, failureVersion: sessionRead.failureVersion,
    stored: { last: storedRead.last, hash: storedRead.hash, role: storedRead.role, streamId: storedRead.streamId, createdAt: storedRead.createdAt },
    waiting: sql<WaitingRow[]>`coalesce((select jsonb_agg(to_jsonb(${sql.identifier('chat_waiting')}) order by ${waitingRead.createdAt}) from ${waitingRead}), '[]'::jsonb)`,
  }).from(storedRead).leftJoin(sessionRead, sql`true`)
  const session = { leaseHolder: snapshot.leaseHolder, leaseUntil: snapshot.leaseUntil, lastError: snapshot.lastError, lastErrorAt: snapshot.lastErrorAt }, stored = snapshot.stored
  const waiting = snapshot.waiting.map(event => ({ ...event, createdAt: new Date(event.createdAt), wakeLeaseUntil: event.wakeLeaseUntil ? new Date(event.wakeLeaseUntil) : null }))
  const lastMessage = stored.role ? { role: stored.role, ...(stored.streamId ? { streamId: stored.streamId } : {}), ...(stored.createdAt ? { createdAt: new Date(stored.createdAt) } : {}) } : undefined
  const now = new Date()
  return {
    version: chatProjectionHash(`${limit}|${stored.hash}|${snapshot.failureVersion ?? ''}|${waiting.map(event => `${event.id}:${event.payloadVersion}`).join(',')}`),
    cursor: stored.last,
    ...(coordinatorLeaseActive(session) && session?.leaseHolder?.startsWith('wrun_') ? { streamRunId: session.leaseHolder } : {}),
    ...coordinatorChatState(session, waiting, now, lastMessage),
    ...chatReadObservation(session, waiting, now),
  }
}

export interface BotChatSummary {
  /** The latest reply or message, with cited threads and tasks written as their names; null before the first. */
  line: string | null
  at: string | null
  /** A turn is active, or pending input is new or holds its first live delivery lease. */
  working: boolean
}

/** Each of the person's own bots' latest line and state, for the bot list (the Coordinator's comes with its chat). */
export async function botChats(reader: IssueReader): Promise<Record<string, BotChatSummary>> {
  return (await botChatSnapshot(reader)).items
}

/** The same summaries plus actual lease expiries that can change working
 * without another persistent write. This never renews a turn or wake lease. */
export async function botChatSnapshot(reader: IssueReader) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const workspaces = await activeTaskWorkspaces(reader)
  const readableBots = workspaces.length ? await db.select({ id: bots.id }).from(bots).where(and(eq(bots.ownerId, userId), inArray(bots.workspaceId, workspaces.map(workspace => workspace.id)))) : []
  if (!readableBots.length) return { items: {} as Record<string, BotChatSummary>, expiries: [] as Date[], observedAt: Date.now() }
  const botIds = readableBots.map(bot => bot.id)
  const latest = await db.selectDistinctOn([coordinatorMessages.botId], { botId: coordinatorMessages.botId, message: summaryChatMessage, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(and(eq(coordinatorMessages.userId, userId), inArray(coordinatorMessages.botId, botIds), sql`${coordinatorMessages.message}->>'role' <> 'tool'`))
    .orderBy(coordinatorMessages.botId, desc(coordinatorMessages.position))
  const sessions = await db.select({ botId: coordinatorSessions.botId, leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil, lastError: coordinatorSessions.lastError }).from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), inArray(coordinatorSessions.botId, botIds)))
  const waiting = await db.select({ botId: coordinatorEvents.botId, kind: coordinatorEvents.kind, tier: coordinatorEvents.tier, wakeAttempts: coordinatorEvents.wakeAttempts, wakeLeaseUntil: coordinatorEvents.wakeLeaseUntil, wakeLastError: coordinatorEvents.wakeLastError })
    .from(coordinatorEvents).where(and(eq(coordinatorEvents.userId, userId), inArray(coordinatorEvents.botId, botIds), isNull(coordinatorEvents.deliveredAt)))
  const now = new Date()
  const expiries = [
    ...sessions.flatMap(session => coordinatorLeaseActive(session, now) && session.leaseUntil ? [session.leaseUntil] : []),
    ...waiting.flatMap(event => event.tier !== 'background' && event.kind !== 'matter_handoff' && event.wakeAttempts === 1 && event.wakeLeaseUntil && event.wakeLeaseUntil > now ? [event.wakeLeaseUntil] : []),
  ]
  const result: Record<string, BotChatSummary> = {}
  for (const event of waiting) {
    if (event.botId && !result[event.botId]) result[event.botId] = { line: null, at: null, working: coordinatorChatState(undefined, waiting.filter(row => row.botId === event.botId), now).working }
  }
  for (const session of sessions) {
    if (!session.botId) continue
    result[session.botId] = { line: null, at: null, working: coordinatorChatState(session, waiting.filter(event => event.botId === session.botId), now).working }
  }
  const lines = latest.flatMap(row => {
    if (!row.botId) return []
    const [item] = chatItems([{ position: 0, message: row.message as unknown as ModelMessage, createdAt: row.createdAt }])
    // A failed welcome is no message from the Bot: no preview line and no time to count as unread.
    if (item?.welcome) return []
    // An event's stored text is the model's (English, ids): the preview leaves it out (C1).
    return [{ botId: row.botId, text: item?.from === 'event' ? null : item?.text || null, from: item?.from, at: row.createdAt.toISOString() }]
  })
  // A reply cites threads and tasks by id; the preview names them as the chat's chips do (R-15).
  const sources = await citationNames(reader, lines.flatMap(line => line.from === 'coordinator' && line.text ? [line.text] : []))
  for (const line of lines) {
    const text = line.text && line.from === 'coordinator' ? namedCitations(line.text, sources) : line.text
    result[line.botId] = { ...(result[line.botId] ?? { working: false }), line: text || null, at: line.at }
  }
  return { items: result, expiries, observedAt: now.getTime() }
}

/** The whole conversation for display, newest last. */
export async function conversationForDisplay(userId: string, limit = 200, botId: string) {
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(messagesOf(userId, botId))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  return rows.reverse()
}
