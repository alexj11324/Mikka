import { coordinatorInbox } from './inbox-runtime'
import type { WakeDelivery, WakeExecution } from './inbox-receipts'
import 'server-only'
import { and, asc, desc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm'
import type { ActionContext } from '../operations/action-intents'
import type { ModelMessage } from 'ai'
import { db } from '@/lib/db'
import { agentRuns, agents, coordinatorEvents, coordinatorMessages, coordinatorSessions, issueMembers, issues, type CoordinatorEventTier } from '@/lib/db/schema'
import { chatItems, eventPrompt, type ChatItem, type StoredMessage } from '@/lib/coordinator/context'
import { citedIds, type CitationSource } from '@/lib/coordinator/citations'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskIdentifiers } from '@/lib/task-identifier-server'

// The Coordinator's conversation in Neon. A turn takes the lease, moves the
// inbox into the conversation, answers, and lets go; a wake that finds the
// lease taken leaves its events for the turn that holds it.

/** Inbox events moved into the conversation per take. */
const INBOX_BATCH = 50

/** Undelivered events that should start a turn; issue_done is background even before triage. */
function waking(userId: string) {
  return and(eq(coordinatorEvents.userId, userId), and(isNull(coordinatorEvents.processedAt), inArray(coordinatorEvents.wakeStatus, ['pending','running'])), ne(coordinatorEvents.kind, 'issue_done'), inArray(coordinatorEvents.tier, ['attention','result']))
}

/** Whether any undelivered event should start a turn. */
export async function hasWakingEvents(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: coordinatorEvents.id }).from(coordinatorEvents).where(waking(userId)).limit(1)
  return Boolean(row)
}

/**
 * Takes the lease for `holder` (or renews it) and moves undelivered inbox
 * events into the conversation as user messages. Background events ride along
 * but do not count: with nothing else waiting, nothing moves. `held` is false
 * when another turn holds the lease; that turn will pick the events up.
 */
export async function takeInbox(userId: string, holder: string, delivery?: WakeDelivery) {
  return coordinatorInbox().take(userId, holder, delivery)
}

/** Lets go of the lease. Returns whether events that need a turn arrived meanwhile, so the caller can take them. */
export async function releaseLease(userId: string, holder: string): Promise<boolean> {
  await db.update(coordinatorSessions).set({ leaseHolder: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.leaseHolder, holder)))
  return hasWakingEvents(userId)
}

/** Undelivered events not yet triaged, oldest first. */
export async function untriagedEvents(userId: string) {
  return db.select().from(coordinatorEvents)
    .where(and(eq(coordinatorEvents.userId, userId), isNull(coordinatorEvents.deliveredAt), isNull(coordinatorEvents.tier)))
    .orderBy(asc(coordinatorEvents.sequence)).limit(INBOX_BATCH)
}

export async function setEventTier(id: string, tier: CoordinatorEventTier): Promise<void> {
  await db.update(coordinatorEvents).set({ tier }).where(and(eq(coordinatorEvents.id, id), isNull(coordinatorEvents.tier)))
}

/**
 * Checkpoints the result, then atomically publishes it and acknowledges its event. `warning` says why the
 * reply may be cut short; it shows in the chat until a turn ends cleanly.
 */
export async function appendMessages(userId: string, holder: string, messages: ModelMessage[], warning: string | null = null, actionContext?: ActionContext, delivery?: WakeDelivery): Promise<void> {
  const inbox=coordinatorInbox()
  const id=delivery?.eventId??actionContext?.sourceEventId??await inbox.active(userId)
  if(!id)throw new Error('wakeReceiptRequired')
  const event=await inbox.read(userId,id)
  const token=delivery?.token??event.wake_delivery_token
  if(!token)throw new Error('wakeReceiptRequired')
  await inbox.acknowledge(userId,holder,{eventId:id,token},messages,warning)
}

/** An unacknowledged staged input remains in the durable retry set. */
export async function failTurn(userId: string, holder: string, _error: string, delivery?: WakeDelivery): Promise<void> {
  const inbox=coordinatorInbox(),id=delivery?.eventId??await inbox.active(userId)
  if(!id)return
  const event=await inbox.read(userId,id),token=delivery?.token??event.wake_delivery_token
  if(token)await inbox.fail(userId,holder,{eventId:id,token})
}

/** The summary so far, the memory, and every message after the summary, oldest first. */
export async function loadConversation(userId: string): Promise<{ summary: string | null; memory: string; messages: StoredMessage[] }> {
  const [session] = await db.select().from(coordinatorSessions).where(eq(coordinatorSessions.userId, userId)).limit(1)
  const through = session?.summaryThrough ?? 0
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message })
    .from(coordinatorMessages)
    .where(and(eq(coordinatorMessages.userId, userId), gt(coordinatorMessages.position, through)))
    .orderBy(asc(coordinatorMessages.position))
  return { summary: session?.summary ?? null, memory: session?.memory ?? '', messages: rows.map(row => ({ position: row.position, message: row.message as unknown as ModelMessage })) }
}

/** Replaces every message at or before `through` with `summary`. The messages stay stored. */
export async function saveSummary(userId: string, summary: string, through: number): Promise<void> {
  await db.update(coordinatorSessions).set({ summary, summaryThrough: through, updatedAt: new Date() })
    .where(eq(coordinatorSessions.userId, userId))
}

/** Rewrites the memory with `edit`, under a row lock so two edits do not lose each other. */
export async function editMemory<T>(userId: string, edit: (memory: string) => { memory: string; result: T } | { error: string }, execution?:WakeExecution): Promise<T | { error: string }> {
  if(execution)return coordinatorInbox().effect(userId,execution,async tx=>{
    const session=(await tx.query('SELECT memory FROM coordinator_sessions WHERE "userId"=$1',[userId])).rows[0]
    const outcome=edit(session?.memory??'')
    if('error'in outcome)return outcome
    await tx.query('UPDATE coordinator_sessions SET memory=$2,"updatedAt"=clock_timestamp() WHERE "userId"=$1',[userId,outcome.memory])
    return outcome.result
  })
  return db.transaction(async tx => {
    await tx.insert(coordinatorSessions).values({ userId }).onConflictDoNothing()
    const [session] = await tx.select({ memory: coordinatorSessions.memory }).from(coordinatorSessions)
      .where(eq(coordinatorSessions.userId, userId)).for('update')
    const outcome = edit(session?.memory ?? '')
    if ('error' in outcome) return outcome
    await tx.update(coordinatorSessions).set({ memory: outcome.memory, updatedAt: new Date() }).where(eq(coordinatorSessions.userId, userId))
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
}

/** Looks up the issues and runs cited in `texts`, keeping only what `userId` may see. */
export async function citationSources(userId: string, texts: readonly string[]): Promise<Record<string, CitationSource>> {
  const { issueIds, runIds } = citedIds(texts)
  const sources: Record<string, CitationSource> = {}
  if (issueIds.length) {
    const rows = await db.selectDistinct({ id: issues.id, ownerId: issues.userId, scope: issues.scope, title: issues.title, status: issues.status, priority: issues.priority, content: issues.content })
      .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
      .where(and(inArray(issues.id, issueIds), or(eq(issues.userId, userId), eq(issueMembers.memberId, userId))))
    const identifiers = await taskIdentifiers(rows.map(row => ({ id: row.id, ownerId: row.ownerId, scope: row.scope, number: readIssueMetadata(row.content).number })))
    for (const { content, ownerId: _owner, scope: _scope, ...row } of rows) {
      const metadata = readIssueMetadata(content)
      if (!metadata.deletedAt) sources[row.id] = { kind: 'issue', ...row, number: metadata.number ?? null, identifier: identifiers.get(row.id) ?? null }
    }
  }
  if (runIds.length) {
    const rows = await db.select({ id: agentRuns.id, agentName: agents.name, harness: agents.harness, status: agentRuns.status, createdAt: agentRuns.createdAt, finishedAt: agentRuns.finishedAt, issueId: issues.id, issueOwnerId: issues.userId, issueScope: issues.scope, issueTitle: issues.title, issueContent: issues.content })
      .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(issues, eq(issues.id, agentRuns.issueId))
      .where(and(inArray(agentRuns.id, runIds), eq(agentRuns.userId, userId)))
    const identifiers = await taskIdentifiers(rows.flatMap(row => row.issueId && row.issueOwnerId && row.issueScope && row.issueContent ? [{ id: row.issueId, ownerId: row.issueOwnerId, scope: row.issueScope, number: readIssueMetadata(row.issueContent).number }] : []))
    for (const row of rows) {
      const issue = row.issueId && row.issueTitle && row.issueContent && !readIssueMetadata(row.issueContent).deletedAt
        ? { id: row.issueId, title: row.issueTitle, number: readIssueMetadata(row.issueContent).number ?? null, identifier: identifiers.get(row.issueId) ?? null } : null
      sources[row.id] = { kind: 'run', id: row.id, agentName: row.agentName, harness: row.harness, status: row.status, issue, createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null }
    }
  }
  return sources
}

/** The latest of the conversation for the chat, oldest first. */
export async function chatView(userId: string, limit = 200): Promise<ChatView> {
  const [session] = await db.select().from(coordinatorSessions).where(eq(coordinatorSessions.userId, userId)).limit(1)
  const rows = await db.select({ id: coordinatorMessages.id, position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(eq(coordinatorMessages.userId, userId))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  // Events still in the inbox: the person's own messages show at once, ahead of the turn that takes them.
  const waiting = await db.select().from(coordinatorEvents)
    .where(and(eq(coordinatorEvents.userId, userId), isNull(coordinatorEvents.processedAt), inArray(coordinatorEvents.wakeStatus, ['pending','running'])))
    .orderBy(asc(coordinatorEvents.sequence)).limit(INBOX_BATCH)
  const last = rows[0]?.position ?? 0
  const pending = waiting.filter(event => event.kind === 'user_message' && !event.deliveredAt).map((event, index) => ({
    position: last + index + 1, createdAt: event.createdAt, message: { role: 'user', content: eventPrompt(event) } as ModelMessage,
  }))
  const leased = Boolean(session?.leaseUntil && session.leaseUntil.getTime() > Date.now())
  const items = chatItems([...rows.reverse().map(row => ({ ...row, message: row.message as unknown as ModelMessage })), ...pending])
  return {
    items,
    working: leased || waiting.some(event => event.tier !== 'background'),
    error: session?.lastError ?? null,
    sources: await citationSources(userId, items.filter(item => item.from === 'coordinator').map(item => item.text)),
  }
}

/** The whole conversation for display, newest last. */
export async function conversationForDisplay(userId: string, limit = 200) {
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(eq(coordinatorMessages.userId, userId))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  return rows.reverse()
}
