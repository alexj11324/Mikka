import { sourcedEventMessage } from './message-safety'
import { visibleRuns } from '@/lib/agent-runs'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { issueForUser } from '@/lib/issue-access'
import { issueVisibility } from '@/lib/issue-visibility'
import 'server-only'
import { COORDINATOR_WELCOME_MARK } from '@/lib/agent-welcome'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm'
import type { ModelMessage } from 'ai'
import { db } from '@/lib/db'
import { agentRuns, coordinatorEvents, coordinatorMessages, coordinatorSessions, issueMembers, issues, pendingActions, runChunks, type CoordinatorEventTier } from '@/lib/db/schema'
import { z } from 'zod'
import { taskDestinationSchema } from '@/lib/task-destination'
import { validateRepositoryApproval } from '@/lib/repository-approval-proposal'
import { markTelegramPending, pendingTelegramTargets, type PendingTelegramTarget } from './telegram-pending'
import { chatItems, eventPrompt, type ChatItem, type StoredMessage } from '@/lib/coordinator/context'
import { eventsForInbox, isolateTaskRequest } from '@/lib/coordinator/triage'
import { citedIds, namedCitations, type CitationSource } from '@/lib/coordinator/citations'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { artifactSummaries, type ArtifactSummary } from '@/lib/artifacts/store'
import { runSummaryText } from '@/lib/issue-run-conversation'
import { threadName } from '@/lib/issue-threads'
import { coordinatorChatState } from './chat-state'
import { coordinatorLeaseActive } from './lease'
import { readPreferences } from '@/lib/preferences'
import type { InboxEvent } from '@/lib/push-reasons'
import { TRIAGE_RETRY_COOLDOWN_MS } from './triage-batch'
import type { TriageJudgment } from './triage-batch'
import type { DecisionExecution } from './decide'
import type { ScheduledRead } from '@/lib/schedules/contract'
import { scheduledInbox, type Occurrence } from '@/lib/schedules/store'

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

/** The person's chats (the Coordinator's among them) with events that should start a turn. */
export async function wakingChats(userId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ botId: coordinatorEvents.botId }).from(coordinatorEvents).where(and(eq(coordinatorEvents.userId, userId), isNotNull(coordinatorEvents.botId), isNull(coordinatorEvents.deliveredAt), or(isNull(coordinatorEvents.tier), ne(coordinatorEvents.tier, 'background'))))
  return rows.flatMap(row => row.botId ? [row.botId] : [])
}

/**
 * Takes the lease for `holder` (or renews it) and moves undelivered inbox
 * events into the conversation as user messages. Background events ride along
 * but do not count: with nothing else waiting, nothing moves. `held` is false
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
  scheduledRead?: ScheduledRead
  approvedRepositoryKey?: string
}

const NO_TAKE = { added: 0, telegramTargets: [], handoffMatterIds: [], handoffOnly: false, pushEvents: [], pushHidesText: false }

export async function takeInbox(userId: string, holder: string, botId: string): Promise<InboxTake> {
  return db.transaction(async tx => {
    const now = new Date()
    await tx.insert(coordinatorSessions).values({ userId, botId }).onConflictDoNothing()
    const [taken] = await tx.update(coordinatorSessions)
      .set({ leaseHolder: holder, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
      .where(and(sessionOf(userId, botId), or(isNull(coordinatorSessions.leaseUntil), lt(coordinatorSessions.leaseUntil, now), eq(coordinatorSessions.leaseHolder, holder))))
      .returning({ userId: coordinatorSessions.userId })
    if (!taken) return { held: false, ...NO_TAKE }
    const candidates = await tx.select().from(coordinatorEvents).where(waking(userId, botId))
      .orderBy(asc(coordinatorEvents.createdAt)).limit(INBOX_BATCH)
    // A schedule is a separate read-only turn. Hydrate its authority through
    // the stored event link, never from notification/model payload fields.
    const scheduledCandidate = candidates[0]?.payload.source === 'schedule_due' ? candidates[0] : undefined
    const scheduledRow=scheduledCandidate?(await tx.execute(sql`SELECT o.* FROM schedule_occurrences o JOIN user_schedules s ON s.id=o.schedule_id WHERE o.event_id=${scheduledCandidate.id} AND s.owner_id=${userId} AND s.bot_id=${botId}::uuid LIMIT 1`)).rows[0] as Occurrence|undefined:undefined
    const scheduled=scheduledInbox(scheduledRow,now)
    if(scheduled && !scheduled.scope){
      await tx.update(coordinatorEvents).set({deliveredAt:now,tier:'background'}).where(eq(coordinatorEvents.id,scheduled.eventId))
      return {held:true,...NO_TAKE}
    }
    const scheduledRead=scheduled?.scope??undefined
    const due = scheduledRead ? [scheduledCandidate!] : isolateTaskRequest(candidates.filter(event => event.payload.source !== 'schedule_due' || event.id === scheduledCandidate?.id))
    if (!due.length) return { held: true, ...NO_TAKE }
    let taskEventId = due.length === 1 && due[0].kind === 'user_message' && due[0].payload.taskDestination !== undefined ? due[0].id : undefined
    let approvedRepositoryKey: string | undefined
    const approval = due.length === 1 && due[0].kind === 'action_decided' && due[0].payload.action === 'approve_repository_push' && due[0].payload.status === 'done' ? due[0] : undefined
    if (approval && z.uuid().safeParse(approval.payload.requestEventId).success && z.uuid().safeParse(approval.payload.actionId).success) {
      const [request] = await tx.select().from(pendingActions).where(and(eq(pendingActions.id, approval.payload.actionId as string), eq(pendingActions.userId, userId), eq(pendingActions.action, 'approve_repository_push'), eq(pendingActions.status, 'done'))).limit(1)
      const taskIds = z.array(z.uuid()).safeParse(request?.context?.taskEventIds)
      const binding = validateRepositoryApproval(request?.input)
      if (binding && taskIds.success && taskIds.data.includes(approval.payload.requestEventId as string)) {
        const [original] = await tx.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.id, approval.payload.requestEventId as string), eventsOf(userId, botId), eq(coordinatorEvents.kind, 'user_message'))).limit(1)
        const destination = taskDestinationSchema.safeParse(original?.payload.taskDestination)
        if (original?.deliveredAt && destination.success && destination.data.kind === 'device') {
          taskEventId = original.id
          approvedRepositoryKey = binding.remoteKey
        }
      }
    }
    const sourceEventId = scheduled ? undefined : due.findLast(event => event.kind === 'user_message')?.id
    const isolatedTask = Boolean(taskEventId) || Boolean(approval) || Boolean(scheduled)
    const backgroundLimit = isolatedTask ? 0 : INBOX_BATCH - due.length
    const background = backgroundLimit ? await tx.select().from(coordinatorEvents)
      .where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt), notInArray(coordinatorEvents.id, due.map(event => event.id)), eq(coordinatorEvents.tier, 'background')))
      .orderBy(asc(coordinatorEvents.createdAt)).limit(backgroundLimit) : []
    const events = eventsForInbox(due, background, INBOX_BATCH)
    if (!events.length) return { held: true, ...NO_TAKE }
    const chatEvents = events.filter(event => !(event.kind === 'user_message' && event.payload.postedToChat === true))
    const first = await nextPosition(tx, userId, botId)
    if (chatEvents.length) await tx.insert(coordinatorMessages).values(chatEvents.map((event, index) => ({
      id: crypto.randomUUID(), userId, botId, position: first + index,
      message: sourcedEventMessage({ ...event, deliveredAt: now }, scheduledRead ? `[Scheduled read-only task] The person requested this stored task for now: ${scheduledRead.prompt}\nUse only the available allowed read tools. Do not create or change anything, request approval, schedule more work, or claim an external write. Return the result for this original chat.` : eventPrompt(event)),
    })))
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
    return {
      held: true, added: events.length,
      ...(taskEventId ? { taskEventId } : {}),
      ...(sourceEventId ? { sourceEventId } : {}),
      ...(scheduledRead ? { scheduledRead } : {}),
      ...(approvedRepositoryKey ? { approvedRepositoryKey } : {}),
      // A verification code is told in the app chat only, never on Telegram.
      telegramTargets: handoffs.some(carriesCode) ? [] : pendingTelegramTargets(pendingReplies),
      handoffMatterIds: handoffs.flatMap(event => typeof event.payload.matterId === 'string' ? [event.payload.matterId] : []),
      handoffOnly: handoffs.length === events.length,
      pushEvents: events.map(event => ({ kind: event.kind, tier: event.tier })),
      pushHidesText: handoffs.some(carriesCode),
    }
  })
}

function isHandoff(kind: string): boolean {
  return kind === 'matter_handoff'
}

function carriesCode(event: { payload: Record<string, unknown> }): boolean {
  const assessment = event.payload.assessment
  return Boolean(assessment && typeof assessment === 'object' && (assessment as { verificationCode?: unknown }).verificationCode)
}

/** Lets go of the lease. Returns whether events that need a turn arrived meanwhile, so the caller can take them. */
export async function releaseLease(userId: string, holder: string, botId: string): Promise<boolean> {
  await db.update(coordinatorSessions).set({ leaseHolder: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(sessionOf(userId, botId), eq(coordinatorSessions.leaseHolder, holder)))
  return hasWakingEvents(userId, botId)
}

/** Direct user delivery first. Runtime ordering uses the last attempt, falling
 * back to original creation time. Trying a slow event advances the durable
 * cursor instead of repeatedly hiding all events after the oldest batch. */
export async function untriagedEvents(userId: string, botId: string) {
  const retryBefore = new Date(Date.now() - TRIAGE_RETRY_COOLDOWN_MS)
  const events = await db.select().from(coordinatorEvents)
    .where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt), isNull(coordinatorEvents.tier),
      or(eq(coordinatorEvents.kind, 'user_message'), isNull(coordinatorEvents.lastTriageAttemptAt), lt(coordinatorEvents.lastTriageAttemptAt, retryBefore))))
    .orderBy(desc(eq(coordinatorEvents.kind, 'user_message')), asc(sql`coalesce(${coordinatorEvents.lastTriageAttemptAt}, ${coordinatorEvents.createdAt})`), asc(coordinatorEvents.id)).limit(INBOX_BATCH)
  const runIds = [...new Set(events.flatMap(event => event.runId ? [event.runId] : []))]
  // Reuse the existing visibility gate; teammate projections stay restricted.
  const observed = new Map((runIds.length ? await visibleRuns(userId, { runIds, limit: runIds.length }) : [])
    .map(run => [run.id, { id: run.id, status: run.status, finishedAt: run.finishedAt }]))
  return events.map(event => ({ ...event, observedRun: event.runId ? observed.get(event.runId) ?? null : null }))
}

export async function setEventTier(id: string, tier: CoordinatorEventTier, scope: { userId: string; botId: string }): Promise<boolean> {
  const applied = await db.update(coordinatorEvents).set({ tier }).where(and(eq(coordinatorEvents.id, id), isNull(coordinatorEvents.deliveredAt), isNull(coordinatorEvents.tier), eventsOf(scope.userId, scope.botId))).returning({ id: coordinatorEvents.id })
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
  return applied.length === 1
}

/**
 * Appends the turn's new messages and renews the lease. `warning` says why the
 * reply may be cut short; it shows in the chat until a turn ends cleanly.
 */
export async function appendMessages(userId: string, holder: string, messages: ModelMessage[], warning: string | null = null, botId: string, streamId?: string): Promise<number> {
  await assertCredentialSafeChat(userId, messages)
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT 1 FROM coordinator_sessions WHERE "userId"=${userId} AND "botId"=${botId}::uuid FOR UPDATE`)
    const first = await nextPosition(tx, userId, botId)
    if (messages.length) {
      await tx.insert(coordinatorMessages).values(messages.map((message, index) => {
        const { mikkaStreamId: _untrusted, ...plain } = message as unknown as Record<string, unknown>
        return { id: crypto.randomUUID(), userId, botId, position: first + index,
          message: { ...plain, ...(message.role === 'assistant' && streamId ? { mikkaStreamId: streamId } : {}) } }
      }))
    }
    const now = new Date()
    await tx.update(coordinatorSessions).set({ leaseUntil: new Date(now.getTime() + LEASE_MS), lastError: warning, lastErrorAt: warning ? now : null, updatedAt: now })
      .where(and(sessionOf(userId, botId), eq(coordinatorSessions.leaseHolder, holder)))
    return first + messages.length - 1
  })
}

/**
 * 重试 on a failed reply: runs the same turn again over the conversation as it
 * stands, so the person's message is not sent twice. The event never becomes a
 * chat message, and one failure can be retried once; a new failure can be
 * retried again. False when nothing failed or a turn is already running.
 */
export async function retryFailedTurn(userId: string, botId: string): Promise<boolean> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT 1 FROM coordinator_sessions WHERE "userId"=${userId} AND "botId"=${botId}::uuid FOR UPDATE`)
    const [session] = await tx.select().from(coordinatorSessions).where(sessionOf(userId, botId)).limit(1)
    if (!session?.lastError || !session.lastErrorAt || coordinatorLeaseActive(session)) return false
    const inserted = await tx.insert(coordinatorEvents).values({
      id: crypto.randomUUID(), userId, botId, kind: 'user_message', issueId: null, runId: null,
      dedupeKey: `turn_retry:${userId}:${botId}:${session.lastErrorAt.toISOString()}`,
      payload: { text: '', postedToChat: true, retry: true },
    }).onConflictDoNothing({ target: coordinatorEvents.dedupeKey }).returning({ id: coordinatorEvents.id })
    return inserted.length === 1
  })
}

/** Records why a turn failed and lets go of the lease. */
export async function failTurn(userId: string, holder: string, error: string, botId: string): Promise<void> {
  await db.update(coordinatorSessions).set({ leaseHolder: null, leaseUntil: null, lastError: error.slice(0, 1000), lastErrorAt: new Date(), updatedAt: new Date() })
    .where(and(sessionOf(userId, botId), eq(coordinatorSessions.leaseHolder, holder)))
}

/** The summary so far, the memory, and every message after the summary, oldest first. */
export async function loadConversation(userId: string, botId: string): Promise<{ summary: string | null; memory: string; messages: StoredMessage[] }> {
  const [session] = await db.select().from(coordinatorSessions).where(sessionOf(userId, botId)).limit(1)
  const through = session?.summaryThrough ?? 0
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message })
    .from(coordinatorMessages)
    .where(and(messagesOf(userId, botId), gt(coordinatorMessages.position, through)))
    .orderBy(asc(coordinatorMessages.position))
  // 使用记忆 off (the app's 记忆 setting): the prompt leaves the memory out; it stays saved.
  const memory = (await readPreferences(userId)).memoryEnabled ? session?.memory ?? '' : ''
  return { summary: session?.summary ?? null, memory, messages: rows.map(row => {
    const { mikkaStreamId: _streamId, ...message } = row.message
    return { position: row.position, message: message as unknown as ModelMessage }
  }) }
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
    await tx.update(coordinatorSessions).set({ memory: outcome.memory, updatedAt: new Date() }).where(sessionOf(userId, botId))
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
  /** The issues and runs the replies cite, by id, that this person can see. */
  sources: Record<string, CitationSource>
  /** The artifacts shown as cards, by id. */
  artifacts: Record<string, ArtifactSummary>
}

/** Looks up the issues and runs cited in `texts`, and the `threads` dispatched, keeping only what `userId` may see. */
export async function citationSources(userId: string, texts: readonly string[], threads: readonly string[] = []): Promise<Record<string, CitationSource>> {
  const cited = citedIds(texts)
  const issueIds = cited.issueIds
  const runIds = [...new Set([...cited.runIds, ...threads])]
  const sources: Record<string, CitationSource> = {}
  if (issueIds.length) {
    const rows = await db.selectDistinct({ id: issues.id, ownerId: issues.userId, scope: issues.scope, title: issues.title, status: issues.status, priority: issues.priority, content: issues.content })
      .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
      .where(and(inArray(issues.id, issueIds), (await issueVisibility(userId)).predicate))
    const identifiers = await taskIdentifiers(rows.map(row => ({ id: row.id, ownerId: row.ownerId, scope: row.scope, number: readIssueMetadata(row.content).number })))
    for (const { content, ownerId: _owner, scope: _scope, ...row } of rows) {
      const metadata = readIssueMetadata(content)
      if (!metadata.deletedAt) sources[row.id] = { kind: 'issue', ...row, number: metadata.number ?? null, identifier: identifiers.get(row.id) ?? null }
    }
  }
  if (runIds.length) {
    const rows = await visibleRuns(userId, { runIds, limit: runIds.length })
    // A teammate's run arrives as the bare projection (no agent id): its prompt, report and steps stay with its owner.
    const ownIds = rows.filter(row => row.agentId).map(row => row.id)
    const prompts = new Map((ownIds.length ? await db.select({ id: agentRuns.id, prompt: agentRuns.prompt }).from(agentRuns)
      .where(and(inArray(agentRuns.id, ownIds), eq(agentRuns.userId, userId))) : []).map(row => [row.id, row.prompt]))
    const steps = new Map((ownIds.length ? await db.select({ runId: runChunks.runId, count: sql<number>`count(*)` }).from(runChunks)
      .where(and(inArray(runChunks.runId, ownIds), sql`${runChunks.chunk}->>'type' = 'tool-input-available'`)).groupBy(runChunks.runId) : [])
      .map(row => [row.runId, Number(row.count)]))
    for (const row of rows) {
      const task = row.issueId ? await issueForUser(userId, row.issueId) : null
      const identifiers = task ? await taskIdentifiers([{ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number }]) : new Map<string, string>()
      const issue = task ? { id: task.id, title: task.title, number: readIssueMetadata(task.content).number ?? null, identifier: identifiers.get(task.id) ?? null } : null
      sources[row.id] = { kind: 'run', id: row.id, agentName: row.agentName, harness: row.harness, status: row.status, issue,
        pullRequests: task ? readIssueMetadata(task.content).pullRequests : [],
        name: threadName(prompts.get(row.id) ?? '', row.agentName), summary: runSummaryText(row), steps: steps.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null }
    }
  }
  return sources
}

/** A waiting message as the chat shows it: its words, and a stand-in per photo so the chat can count them. */
function withImages(text: string, images: unknown): ModelMessage['content'] {
  if (!Array.isArray(images) || !images.length) return text
  return [{ type: 'text', text }, ...images.map(() => ({ type: 'file' as const, data: '', mediaType: 'image/jpeg' }))]
}

/** The latest of the conversation for the chat, oldest first. */
export async function chatView(userId: string, limit = 200, botId: string): Promise<ChatView> {
  const [session] = await db.select().from(coordinatorSessions).where(sessionOf(userId, botId)).limit(1)
  const rows = await db.select({ id: coordinatorMessages.id, position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(messagesOf(userId, botId))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  // Events still in the inbox: the person's own messages show at once, ahead of the turn that takes them.
  const waiting = await db.select().from(coordinatorEvents)
    .where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt)))
    .orderBy(asc(coordinatorEvents.createdAt)).limit(INBOX_BATCH)
  const last = rows[0]?.position ?? 0
  const pending = waiting.filter(event => event.kind === 'user_message' && !String(event.payload.text ?? '').startsWith(COORDINATOR_WELCOME_MARK)).map((event, index) => ({
    position: last + index + 1, createdAt: event.createdAt, message: { role: 'user', content: withImages(eventPrompt(event), event.payload.images) } as ModelMessage, pending: true as const,
  }))
  const items = chatItems([...rows.reverse().map(row => ({ ...row, message: row.message as unknown as ModelMessage })), ...pending])
  return {
    items,
    cursor: last,
    persistedStreamIds: [...new Set(rows.flatMap(({message}) => message.role === 'assistant' && typeof message.mikkaStreamId === 'string' ? [message.mikkaStreamId] : []))],
    ...(coordinatorLeaseActive(session) && session?.leaseHolder?.startsWith('wrun_') ? { streamRunId: session.leaseHolder } : {}),
    ...coordinatorChatState(session, waiting),
    sources: await citationSources(userId, items.filter(item => item.from === 'coordinator').map(item => item.text), items.flatMap(item => item.threads)),
    artifacts: await artifactSummaries(userId, items.flatMap(item => [...item.artifacts, ...(item.quote ? [item.quote.artifactId] : [])])),
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
export async function botChats(userId: string): Promise<Record<string, BotChatSummary>> {
  const latest = await db.selectDistinctOn([coordinatorMessages.botId], { botId: coordinatorMessages.botId, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(and(eq(coordinatorMessages.userId, userId), isNotNull(coordinatorMessages.botId), sql`${coordinatorMessages.message}->>'role' <> 'tool'`))
    .orderBy(coordinatorMessages.botId, desc(coordinatorMessages.position))
  const sessions = await db.select().from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), isNotNull(coordinatorSessions.botId)))
  const waiting = await db.select({ botId: coordinatorEvents.botId, kind: coordinatorEvents.kind, tier: coordinatorEvents.tier, wakeAttempts: coordinatorEvents.wakeAttempts, wakeLeaseUntil: coordinatorEvents.wakeLeaseUntil, wakeLastError: coordinatorEvents.wakeLastError })
    .from(coordinatorEvents).where(and(eq(coordinatorEvents.userId, userId), isNotNull(coordinatorEvents.botId), isNull(coordinatorEvents.deliveredAt)))
  const result: Record<string, BotChatSummary> = {}
  for (const event of waiting) {
    if (event.botId && !result[event.botId]) result[event.botId] = { line: null, at: null, working: coordinatorChatState(undefined, waiting.filter(row => row.botId === event.botId)).working }
  }
  for (const session of sessions) {
    if (!session.botId) continue
    result[session.botId] = { line: null, at: null, working: coordinatorChatState(session, waiting.filter(event => event.botId === session.botId)).working }
  }
  const lines = latest.flatMap(row => {
    if (!row.botId) return []
    const [item] = chatItems([{ position: 0, message: row.message as unknown as ModelMessage, createdAt: row.createdAt }])
    return [{ botId: row.botId, text: item?.text || null, from: item?.from, at: row.createdAt.toISOString() }]
  })
  // A reply cites threads and tasks by id; the preview names them as the chat's chips do (R-15).
  const sources = await citationSources(userId, lines.flatMap(line => line.from === 'coordinator' && line.text ? [line.text] : []))
  for (const line of lines) {
    const text = line.text && line.from === 'coordinator' ? namedCitations(line.text, sources) : line.text
    result[line.botId] = { ...(result[line.botId] ?? { working: false }), line: text || null, at: line.at }
  }
  return result
}

/** The whole conversation for display, newest last. */
export async function conversationForDisplay(userId: string, limit = 200, botId: string) {
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(messagesOf(userId, botId))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  return rows.reverse()
}
