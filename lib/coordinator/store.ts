import { visibleRuns } from '@/lib/agent-runs'
import { issueForUser } from '@/lib/issue-access'
import { issueVisibility } from '@/lib/issue-visibility'
import 'server-only'
import { COORDINATOR_WELCOME_MARK } from '@/lib/agent-welcome'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm'
import type { ModelMessage } from 'ai'
import { db } from '@/lib/db'
import { agentRuns, coordinatorEvents, coordinatorMessages, coordinatorSessions, issueMembers, issues, runChunks, type CoordinatorEventTier } from '@/lib/db/schema'
import { telegramReplyTargets, type TelegramReplyTarget } from '@/lib/coordinator-events'
import { chatItems, eventPrompt, type ChatItem, type StoredMessage } from '@/lib/coordinator/context'
import { eventsForInbox } from '@/lib/coordinator/triage'
import { citedIds, type CitationSource } from '@/lib/coordinator/citations'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { artifactSummaries, type ArtifactSummary } from '@/lib/artifacts/store'
import { runSummaryText } from '@/lib/issue-run-conversation'
import { threadName } from '@/lib/issue-threads'
import { coordinatorLeaseActive } from '@/lib/coordinator/lease'

// The Coordinator's conversation in Neon. A turn takes the lease, moves the
// inbox into the conversation, answers, and lets go; a wake that finds the
// lease taken leaves its events for the turn that holds it.

/** How long a turn may hold the lease before another wake may take over. */
const LEASE_MS = 10 * 60_000
/** Inbox events moved into the conversation per take. */
const INBOX_BATCH = 50

type Executor = Pick<typeof db, 'select' | 'insert' | 'execute'>

// Every bot chats on this harness. `botId` picks the chat: null is the
// person's Coordinator (the built-in bot), otherwise one of their own bots.
// Each chat has its own conversation, memory, inbox and lease.
const ofBot = (column: typeof coordinatorSessions.botId | typeof coordinatorMessages.botId | typeof coordinatorEvents.botId, botId: string | null) => botId ? eq(column, botId) : isNull(column)
const sessionOf = (userId: string, botId: string | null) => and(eq(coordinatorSessions.userId, userId), ofBot(coordinatorSessions.botId, botId))
const messagesOf = (userId: string, botId: string | null) => and(eq(coordinatorMessages.userId, userId), ofBot(coordinatorMessages.botId, botId))
const eventsOf = (userId: string, botId: string | null) => and(eq(coordinatorEvents.userId, userId), ofBot(coordinatorEvents.botId, botId))

async function nextPosition(executor: Executor, userId: string, botId: string | null): Promise<number> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-chat:${userId}:${botId ?? 'coordinator'}`},0))`)
  const [row] = await executor.select({ last: sql<number>`coalesce(max(${coordinatorMessages.position}), 0)` })
    .from(coordinatorMessages).where(messagesOf(userId, botId))
  return Number(row?.last ?? 0) + 1
}

/** Undelivered events that should start a turn; issue_done is background even before triage. */
const wakingEvent = and(isNull(coordinatorEvents.deliveredAt), ne(coordinatorEvents.kind, 'issue_done'), or(isNull(coordinatorEvents.tier), ne(coordinatorEvents.tier, 'background')))
function waking(userId: string, botId: string | null) {
  return and(eventsOf(userId, botId), wakingEvent)
}

/** Whether any undelivered event should start a turn in this chat. */
export async function hasWakingEvents(userId: string, botId: string | null = null): Promise<boolean> {
  const [row] = await db.select({ id: coordinatorEvents.id }).from(coordinatorEvents).where(waking(userId, botId)).limit(1)
  return Boolean(row)
}

/** The person's chats with events that should start a turn: null is the Coordinator. */
export async function wakingChats(userId: string): Promise<(string | null)[]> {
  const rows = await db.selectDistinct({ botId: coordinatorEvents.botId }).from(coordinatorEvents).where(and(eq(coordinatorEvents.userId, userId), wakingEvent))
  return rows.map(row => row.botId)
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
  telegramTargets: TelegramReplyTarget[]
  /** Matters from connected apps handed over in this take (lib/attention). */
  handoffMatterIds: string[]
  /** Every event in the take is a handoff: a reply can only be telling the person about one. */
  handoffOnly: boolean
}

const NO_TAKE = { added: 0, telegramTargets: [], handoffMatterIds: [], handoffOnly: false }

export async function takeInbox(userId: string, holder: string, botId: string | null = null): Promise<InboxTake> {
  return db.transaction(async tx => {
    const now = new Date()
    await tx.insert(coordinatorSessions).values({ userId, botId }).onConflictDoNothing()
    const [taken] = await tx.update(coordinatorSessions)
      .set({ leaseHolder: holder, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
      .where(and(sessionOf(userId, botId), or(isNull(coordinatorSessions.leaseUntil), lt(coordinatorSessions.leaseUntil, now), eq(coordinatorSessions.leaseHolder, holder))))
      .returning({ userId: coordinatorSessions.userId })
    if (!taken) return { held: false, ...NO_TAKE }
    const due = await tx.select().from(coordinatorEvents).where(waking(userId, botId))
      .orderBy(asc(coordinatorEvents.createdAt)).limit(INBOX_BATCH)
    if (!due.length) return { held: true, ...NO_TAKE }
    const backgroundLimit = INBOX_BATCH - due.length
    const background = backgroundLimit ? await tx.select().from(coordinatorEvents)
      .where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt), notInArray(coordinatorEvents.id, due.map(event => event.id)), or(eq(coordinatorEvents.tier, 'background'), eq(coordinatorEvents.kind, 'issue_done'))))
      .orderBy(asc(coordinatorEvents.createdAt)).limit(backgroundLimit) : []
    const events = eventsForInbox(due, background, INBOX_BATCH)
    if (!events.length) return { held: true, ...NO_TAKE }
    const chatEvents = events.filter(event => !(event.kind === 'user_message' && event.payload.postedToChat === true))
    const first = await nextPosition(tx, userId, botId)
    if (chatEvents.length) await tx.insert(coordinatorMessages).values(chatEvents.map((event, index) => ({
      id: crypto.randomUUID(), userId, botId, position: first + index,
      message: { role: 'user', content: eventPrompt(event) } satisfies ModelMessage,
    })))
    await tx.update(coordinatorEvents).set({ deliveredAt: now }).where(inArray(coordinatorEvents.id, events.map(event => event.id)))
    const handoffs = events.filter(event => isHandoff(event.kind))
    return {
      held: true, added: events.length,
      // A verification code is told in the app chat only, never on Telegram.
      telegramTargets: handoffs.some(carriesCode) ? [] : telegramReplyTargets(events),
      handoffMatterIds: handoffs.flatMap(event => typeof event.payload.matterId === 'string' ? [event.payload.matterId] : []),
      handoffOnly: handoffs.length === events.length,
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
export async function releaseLease(userId: string, holder: string, botId: string | null = null): Promise<boolean> {
  await db.update(coordinatorSessions).set({ leaseHolder: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(sessionOf(userId, botId), eq(coordinatorSessions.leaseHolder, holder)))
  return hasWakingEvents(userId, botId)
}

/** Undelivered events not yet triaged, oldest first. */
export async function untriagedEvents(userId: string, botId: string | null = null) {
  return db.select().from(coordinatorEvents)
    .where(and(eventsOf(userId, botId), isNull(coordinatorEvents.deliveredAt), isNull(coordinatorEvents.tier)))
    .orderBy(asc(coordinatorEvents.createdAt)).limit(INBOX_BATCH)
}

export async function setEventTier(id: string, tier: CoordinatorEventTier): Promise<void> {
  await db.update(coordinatorEvents).set({ tier }).where(and(eq(coordinatorEvents.id, id), isNull(coordinatorEvents.tier)))
}

/**
 * Appends the turn's new messages and renews the lease. `warning` says why the
 * reply may be cut short; it shows in the chat until a turn ends cleanly.
 */
export async function appendMessages(userId: string, holder: string, messages: ModelMessage[], warning: string | null = null, botId: string | null = null): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT 1 FROM coordinator_sessions WHERE "userId"=${userId} AND "botId" IS NOT DISTINCT FROM ${botId}::uuid FOR UPDATE`)
    if (messages.length) {
      const first = await nextPosition(tx, userId, botId)
      await tx.insert(coordinatorMessages).values(messages.map((message, index) => ({
        id: crypto.randomUUID(), userId, botId, position: first + index, message: message as unknown as Record<string, unknown>,
      })))
    }
    const now = new Date()
    await tx.update(coordinatorSessions).set({ leaseUntil: new Date(now.getTime() + LEASE_MS), lastError: warning, lastErrorAt: warning ? now : null, updatedAt: now })
      .where(and(sessionOf(userId, botId), eq(coordinatorSessions.leaseHolder, holder)))
  })
}

/** Records why a turn failed and lets go of the lease. */
export async function failTurn(userId: string, holder: string, error: string, botId: string | null = null): Promise<void> {
  await db.update(coordinatorSessions).set({ leaseHolder: null, leaseUntil: null, lastError: error.slice(0, 1000), lastErrorAt: new Date(), updatedAt: new Date() })
    .where(and(sessionOf(userId, botId), eq(coordinatorSessions.leaseHolder, holder)))
}

/** The summary so far, the memory, and every message after the summary, oldest first. */
export async function loadConversation(userId: string, botId: string | null = null): Promise<{ summary: string | null; memory: string; messages: StoredMessage[] }> {
  const [session] = await db.select().from(coordinatorSessions).where(sessionOf(userId, botId)).limit(1)
  const through = session?.summaryThrough ?? 0
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message })
    .from(coordinatorMessages)
    .where(and(messagesOf(userId, botId), gt(coordinatorMessages.position, through)))
    .orderBy(asc(coordinatorMessages.position))
  return { summary: session?.summary ?? null, memory: session?.memory ?? '', messages: rows.map(row => ({ position: row.position, message: row.message as unknown as ModelMessage })) }
}

/** Replaces every message at or before `through` with `summary`. The messages stay stored. */
export async function saveSummary(userId: string, summary: string, through: number, botId: string | null = null): Promise<void> {
  await db.update(coordinatorSessions).set({ summary, summaryThrough: through, updatedAt: new Date() })
    .where(sessionOf(userId, botId))
}

/** Rewrites the memory with `edit`, under a row lock so two edits do not lose each other. */
export async function editMemory<T>(userId: string, edit: (memory: string) => { memory: string; result: T } | { error: string }, botId: string | null = null): Promise<T | { error: string }> {
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
  /** A turn holds the lease or messages wait in the inbox: a reply is coming. */
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
        name: threadName(prompts.get(row.id) ?? '', row.agentName), summary: runSummaryText(row), steps: steps.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null }
    }
  }
  return sources
}

/** The latest of the conversation for the chat, oldest first. */
export async function chatView(userId: string, limit = 200, botId: string | null = null): Promise<ChatView> {
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
    position: last + index + 1, createdAt: event.createdAt, message: { role: 'user', content: eventPrompt(event) } as ModelMessage, pending: true as const,
  }))
  const leased = coordinatorLeaseActive(session)
  const items = chatItems([...rows.reverse().map(row => ({ ...row, message: row.message as unknown as ModelMessage })), ...pending])
  return {
    items,
    // A handoff waiting in the inbox is not shown as a reply coming: the Coordinator may decide to stay quiet.
    working: leased || waiting.some(event => event.tier !== 'background' && !isHandoff(event.kind)),
    error: session?.lastError ?? null,
    sources: await citationSources(userId, items.filter(item => item.from === 'coordinator').map(item => item.text), items.flatMap(item => item.threads)),
    artifacts: await artifactSummaries(userId, items.flatMap(item => [...item.artifacts, ...(item.quote ? [item.quote.artifactId] : [])])),
  }
}

export interface BotChatSummary {
  /** The latest reply or message, as written; null before the first. */
  line: string | null
  at: string | null
  /** A turn holds the lease or the person's messages wait: a reply is coming. */
  working: boolean
}

/** Each of the person's own bots' latest line and state, for the bot list (the Coordinator's comes with its chat). */
export async function botChats(userId: string): Promise<Record<string, BotChatSummary>> {
  const latest = await db.selectDistinctOn([coordinatorMessages.botId], { botId: coordinatorMessages.botId, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(and(eq(coordinatorMessages.userId, userId), isNotNull(coordinatorMessages.botId), sql`${coordinatorMessages.message}->>'role' <> 'tool'`))
    .orderBy(coordinatorMessages.botId, desc(coordinatorMessages.position))
  const sessions = await db.select().from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), isNotNull(coordinatorSessions.botId)))
  const waiting = await wakingChats(userId)
  const result: Record<string, BotChatSummary> = {}
  for (const session of sessions) {
    if (!session.botId) continue
    result[session.botId] = { line: null, at: null, working: coordinatorLeaseActive(session) || waiting.includes(session.botId) }
  }
  for (const row of latest) {
    if (!row.botId) continue
    const [item] = chatItems([{ position: 0, message: row.message as unknown as ModelMessage, createdAt: row.createdAt }])
    result[row.botId] = { ...(result[row.botId] ?? { working: waiting.includes(row.botId) }), line: item?.text || null, at: row.createdAt.toISOString() }
  }
  return result
}

/** The whole conversation for display, newest last. */
export async function conversationForDisplay(userId: string, limit = 200, botId: string | null = null) {
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(messagesOf(userId, botId))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  return rows.reverse()
}
