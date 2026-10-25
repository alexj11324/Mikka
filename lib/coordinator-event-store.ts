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

/** Authenticated transport calls this. submissionId is identity, never authority.
 * Legacy callers omit it and create a new event for each accepted request. */
export async function recordUserSubmission(userId: string, text: string, submissionId?: string, metadata: { questionId?: string; humanSessionId?: string } = {}) {
  const { pool } = await import('./db')
  const { intentDigest } = await import('./operations/action-intents')
  const { OperationError } = await import('./operations/ledger')
  const { randomUUID } = await import('node:crypto')
  const key = `user_message:${userId}:${submissionId ?? randomUUID()}`
  const fingerprint = intentDigest({ text, questionId: metadata.questionId ?? null })
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key])
    const { rows: [old] } = await tx.query('SELECT id,"userId",payload FROM coordinator_events WHERE "dedupeKey"=$1', [key])
    if (old) {
      if (old.userId !== userId || old.payload.submissionDigest !== fingerprint) throw new OperationError('submissionConflict')
      await tx.query('COMMIT'); return { sourceEventId: old.id as string, replayed: true }
    }
    const id = randomUUID()
    await tx.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,$4)`, [id, userId, key, { text, ...metadata, submissionDigest: fingerprint }])
    await tx.query('COMMIT'); return { sourceEventId: id, replayed: false }
  } catch (error) { await tx.query('ROLLBACK'); throw error }
  finally { tx.release() }
}
