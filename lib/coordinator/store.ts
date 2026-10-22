import 'server-only'
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { ModelMessage } from 'ai'
import { db } from '@/lib/db'
import { coordinatorEvents, coordinatorMessages, coordinatorSessions } from '@/lib/db/schema'
import { chatItems, eventPrompt, type ChatItem, type StoredMessage } from '@/lib/coordinator/context'

// The Coordinator's conversation in Neon. A turn takes the lease, moves the
// inbox into the conversation, answers, and lets go; a wake that finds the
// lease taken leaves its events for the turn that holds it.

/** How long a turn may hold the lease before another wake may take over. */
const LEASE_MS = 10 * 60_000
/** Inbox events moved into the conversation per take. */
const INBOX_BATCH = 50

type Executor = Pick<typeof db, 'select' | 'insert'>

async function nextPosition(executor: Executor, userId: string): Promise<number> {
  const [row] = await executor.select({ last: sql<number>`coalesce(max(${coordinatorMessages.position}), 0)` })
    .from(coordinatorMessages).where(eq(coordinatorMessages.userId, userId))
  return Number(row?.last ?? 0) + 1
}

/**
 * Takes the lease for `holder` (or renews it) and moves undelivered inbox
 * events into the conversation as user messages. `held` is false when another
 * turn holds the lease; that turn will pick the events up.
 */
export async function takeInbox(userId: string, holder: string): Promise<{ held: boolean; added: number }> {
  return db.transaction(async tx => {
    const now = new Date()
    await tx.insert(coordinatorSessions).values({ userId }).onConflictDoNothing()
    const [taken] = await tx.update(coordinatorSessions)
      .set({ leaseHolder: holder, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
      .where(and(eq(coordinatorSessions.userId, userId), or(isNull(coordinatorSessions.leaseUntil), lt(coordinatorSessions.leaseUntil, now), eq(coordinatorSessions.leaseHolder, holder))))
      .returning({ userId: coordinatorSessions.userId })
    if (!taken) return { held: false, added: 0 }
    const events = await tx.select().from(coordinatorEvents)
      .where(and(eq(coordinatorEvents.userId, userId), isNull(coordinatorEvents.deliveredAt)))
      .orderBy(asc(coordinatorEvents.createdAt)).limit(INBOX_BATCH)
    if (!events.length) return { held: true, added: 0 }
    const first = await nextPosition(tx, userId)
    await tx.insert(coordinatorMessages).values(events.map((event, index) => ({
      id: crypto.randomUUID(), userId, position: first + index,
      message: { role: 'user', content: eventPrompt(event) } satisfies ModelMessage,
    })))
    await tx.update(coordinatorEvents).set({ deliveredAt: now }).where(inArray(coordinatorEvents.id, events.map(event => event.id)))
    return { held: true, added: events.length }
  })
}

/** Lets go of the lease. Returns whether events arrived meanwhile, so the caller can take them. */
export async function releaseLease(userId: string, holder: string): Promise<boolean> {
  await db.update(coordinatorSessions).set({ leaseHolder: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.leaseHolder, holder)))
  const [waiting] = await db.select({ id: coordinatorEvents.id }).from(coordinatorEvents)
    .where(and(eq(coordinatorEvents.userId, userId), isNull(coordinatorEvents.deliveredAt))).limit(1)
  return Boolean(waiting)
}

/** Appends the turn's new messages and renews the lease. */
export async function appendMessages(userId: string, holder: string, messages: ModelMessage[]): Promise<void> {
  await db.transaction(async tx => {
    if (messages.length) {
      const first = await nextPosition(tx, userId)
      await tx.insert(coordinatorMessages).values(messages.map((message, index) => ({
        id: crypto.randomUUID(), userId, position: first + index, message: message as unknown as Record<string, unknown>,
      })))
    }
    await tx.update(coordinatorSessions).set({ leaseUntil: new Date(Date.now() + LEASE_MS), lastError: null, lastErrorAt: null, updatedAt: new Date() })
      .where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.leaseHolder, holder)))
  })
}

/** Records why a turn failed and lets go of the lease. */
export async function failTurn(userId: string, holder: string, error: string): Promise<void> {
  await db.update(coordinatorSessions).set({ leaseHolder: null, leaseUntil: null, lastError: error.slice(0, 1000), lastErrorAt: new Date(), updatedAt: new Date() })
    .where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.leaseHolder, holder)))
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
export async function editMemory<T>(userId: string, edit: (memory: string) => { memory: string; result: T } | { error: string }): Promise<T | { error: string }> {
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
}

/** The latest of the conversation for the chat, oldest first. */
export async function chatView(userId: string, limit = 200): Promise<ChatView> {
  const [session] = await db.select().from(coordinatorSessions).where(eq(coordinatorSessions.userId, userId)).limit(1)
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(eq(coordinatorMessages.userId, userId))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  // Events still in the inbox: the person's own messages show at once, ahead of the turn that takes them.
  const waiting = await db.select().from(coordinatorEvents)
    .where(and(eq(coordinatorEvents.userId, userId), isNull(coordinatorEvents.deliveredAt)))
    .orderBy(asc(coordinatorEvents.createdAt)).limit(INBOX_BATCH)
  const last = rows[0]?.position ?? 0
  const pending = waiting.filter(event => event.kind === 'user_message').map((event, index) => ({
    position: last + index + 1, createdAt: event.createdAt, message: { role: 'user', content: eventPrompt(event) } as ModelMessage,
  }))
  const leased = Boolean(session?.leaseUntil && session.leaseUntil.getTime() > Date.now())
  return {
    items: chatItems([...rows.reverse().map(row => ({ ...row, message: row.message as unknown as ModelMessage })), ...pending]),
    working: leased || waiting.length > 0,
    error: session?.lastError ?? null,
  }
}

/** The whole conversation for display, newest last. */
export async function conversationForDisplay(userId: string, limit = 200) {
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(eq(coordinatorMessages.userId, userId))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  return rows.reverse()
}
