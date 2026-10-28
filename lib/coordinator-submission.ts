import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { coordinatorEvents } from './db/schema'
import type { db } from './db'
import { taskDestinationSchema, type TaskDestination } from './task-destination'

/** Personal Coordinator HTTP contract. Question/approval fields are not supported. */
export const personalSubmissionInput = z.object({
  text: z.string().trim().min(1).max(10_000),
  submissionId: z.uuid().transform(value => value.toLowerCase()).optional(),
}).strict()

export class SubmissionConflictError extends Error {
  constructor() { super('submissionConflict') }
}

type Executor = Pick<typeof db, 'insert' | 'select'>

/** Caller authenticates the person and validates any Bot ownership before calling. */
export async function recordPersonalSubmission(executor: Executor, userId: string, text: string, options: { submissionId?: string; botId?: string | null; taskDestination?: TaskDestination } = {}) {
  const submissionId = personalSubmissionInput.shape.submissionId.parse(options.submissionId)
  const botId = options.botId ?? null
  const taskDestination = options.taskDestination ? taskDestinationSchema.parse(options.taskDestination) : undefined
  const dedupeKey = submissionId
    ? `personal_submission:v1:${createHash('sha256').update(JSON.stringify([userId, botId, submissionId])).digest('hex')}`
    : `user_message:${randomUUID()}`
  const event = { userId, botId, kind: 'user_message' as const, dedupeKey, issueId: null, runId: null, payload: { text, ...(taskDestination ? { taskDestination } : {}) } }
  const [inserted] = await executor.insert(coordinatorEvents).values({ id: randomUUID(), ...event })
    .onConflictDoNothing({ target: coordinatorEvents.dedupeKey }).returning({ id: coordinatorEvents.id })
  if (inserted) return { duplicate: false, eventId: inserted.id }
  // The unique index arbitrates concurrent writers. A separate read observes
  // the winning committed row without changing its payload or delivery state.
  const [prior] = await executor.select({ id: coordinatorEvents.id, userId: coordinatorEvents.userId, botId: coordinatorEvents.botId, kind: coordinatorEvents.kind, issueId: coordinatorEvents.issueId, runId: coordinatorEvents.runId, payload: coordinatorEvents.payload })
    .from(coordinatorEvents).where(eq(coordinatorEvents.dedupeKey, dedupeKey)).limit(1)
  if (!prior) throw new Error('personalSubmissionUnavailable')
  if (!submissionId || prior.userId !== userId || prior.botId !== botId || prior.kind !== event.kind || (prior.issueId !== null && !taskDestination) || prior.runId !== null || !isDeepStrictEqual(prior.payload, event.payload)) throw new SubmissionConflictError()
  return { duplicate: true, eventId: prior.id }
}
