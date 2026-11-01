import 'server-only'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { coordinatorEvents } from '@/lib/db/schema'
import type { CoordinatorEventInput } from '@/lib/coordinator-events'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { chatBotId } from '@/lib/coordinator/coordinator-bot'

type Executor = Pick<typeof db, 'insert'>

/**
 * Writes the event once; a repeat with the same dedupe key is ignored. The
 * event names its chat's bot itself (CoordinatorEventInput.botId); nothing is
 * resolved here, so run completion, recovery and publication never depend on
 * the Coordinator lookup.
 */
export async function recordCoordinatorEvent(executor: Executor, event: CoordinatorEventInput) {
  await assertCredentialSafeChat(event.userId, event.payload)
  await executor.insert(coordinatorEvents).values({ id: crypto.randomUUID(), ...event }).onConflictDoNothing({ target: coordinatorEvents.dedupeKey })
}

/** The person's events their Coordinator (not another bot) has not taken yet, oldest first. */
export async function pendingCoordinatorEvents(userId: string, limit = 50) {
  const botId = await chatBotId(userId, null)
  return db.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.userId, userId), eq(coordinatorEvents.botId, botId), isNull(coordinatorEvents.deliveredAt))).orderBy(asc(coordinatorEvents.createdAt)).limit(limit)
}

/** Marks events as taken by the Coordinator, so they are not handed over again. */
export async function markCoordinatorEventsDelivered(userId: string, ids: string[]) {
  if (!ids.length) return
  const botId = await chatBotId(userId, null)
  await db.update(coordinatorEvents).set({ deliveredAt: new Date() }).where(and(eq(coordinatorEvents.userId, userId), eq(coordinatorEvents.botId, botId), inArray(coordinatorEvents.id, ids), isNull(coordinatorEvents.deliveredAt)))
}
