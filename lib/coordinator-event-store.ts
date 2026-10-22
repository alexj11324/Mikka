import 'server-only'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { coordinatorEvents } from '@/lib/db/schema'
import type { CoordinatorEventInput } from '@/lib/coordinator-events'

type Executor = Pick<typeof db, 'insert'>

/** Writes the event once; a repeat with the same dedupe key is ignored. */
export async function recordCoordinatorEvent(executor: Executor, event: CoordinatorEventInput) {
  await executor.insert(coordinatorEvents).values({ id: crypto.randomUUID(), ...event }).onConflictDoNothing({ target: coordinatorEvents.dedupeKey })
}

/** The person's events the Coordinator has not taken yet, oldest first. */
export async function pendingCoordinatorEvents(userId: string, limit = 50) {
  return db.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.userId, userId), isNull(coordinatorEvents.deliveredAt))).orderBy(asc(coordinatorEvents.createdAt)).limit(limit)
}

/** Marks events as taken by the Coordinator, so they are not handed over again. */
export async function markCoordinatorEventsDelivered(userId: string, ids: string[]) {
  if (!ids.length) return
  await db.update(coordinatorEvents).set({ deliveredAt: new Date() }).where(and(eq(coordinatorEvents.userId, userId), inArray(coordinatorEvents.id, ids), isNull(coordinatorEvents.deliveredAt)))
}
