import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { normalizeUserImages, userImageInputsSchema, MAX_PERSONAL_SUBMISSION_BYTES, type UserImageInput } from './coordinator/user-attachments'
import { coordinatorEvents } from './db/schema'
import type { db } from './db'
import { MESSAGE_MAX } from './message-limits'
import { taskDestinationSchema, type TaskDestination } from './task-destination'

/** Personal Coordinator HTTP contract. Question/approval fields are not supported. */
export const personalSubmissionInput = z.object({
  text: z.string().trim().max(MESSAGE_MAX).default(''),
  images: userImageInputsSchema.optional(),
  submissionId: z.uuid().transform(value => value.toLowerCase()).optional(),
}).strict().refine(value => Boolean(value.text || value.images?.length), {message:'messageRequired'})

export class SubmissionConflictError extends Error {
  constructor() { super('submissionConflict') }
}

type Executor = Pick<typeof db, 'insert' | 'select'>

function submissionKey(userId: string, botId: string | null, submissionId: string) {
  return `personal_submission:v1:${createHash('sha256').update(JSON.stringify([userId, botId, submissionId])).digest('hex')}`
}

/** Read an existing receipt without inserting an event for an already-dismissed suggestion. */
export async function personalSubmissionRecorded(executor: Pick<typeof db, 'select'>, userId: string, text: string, submissionId: string): Promise<boolean> {
  const id = personalSubmissionInput.shape.submissionId.parse(submissionId)!
  const [prior] = await executor.select({ userId: coordinatorEvents.userId, botId: coordinatorEvents.botId, kind: coordinatorEvents.kind, issueId: coordinatorEvents.issueId, runId: coordinatorEvents.runId, payload: coordinatorEvents.payload })
    .from(coordinatorEvents).where(eq(coordinatorEvents.dedupeKey, submissionKey(userId, null, id))).limit(1)
  if (!prior) return false
  if (prior.userId !== userId || prior.botId !== null || prior.kind !== 'user_message' || prior.issueId !== null || prior.runId !== null || !isDeepStrictEqual(prior.payload, { text })) throw new SubmissionConflictError()
  return true
}

/** Caller authenticates the person and validates any Bot ownership before calling. */
export async function recordPersonalSubmission(executor: Executor, userId: string, text: string, options: { submissionId?: string; botId?: string | null; images?: readonly UserImageInput[]; taskDestination?: TaskDestination; humanSessionId?: string } = {}) {
  const submissionId = personalSubmissionInput.shape.submissionId.parse(options.submissionId)
  const botId = options.botId ?? null
  const images = normalizeUserImages(options.images)
  const taskDestination = options.taskDestination ? taskDestinationSchema.parse(options.taskDestination) : undefined
  const dedupeKey = submissionId
    ? submissionKey(userId, botId, submissionId)
    : `user_message:${randomUUID()}`
  const event = { userId, botId, kind: 'user_message' as const, dedupeKey, issueId: null, runId: null, payload: { text, ...(images.length ? { images } : {}), ...(taskDestination ? { taskDestination } : {}), ...(options.humanSessionId ? { humanSessionId: options.humanSessionId } : {}) } }
  const [inserted] = await executor.insert(coordinatorEvents).values({ id: randomUUID(), ...event })
    .onConflictDoNothing({ target: coordinatorEvents.dedupeKey }).returning({ id: coordinatorEvents.id })
  if (inserted) return { duplicate: false, eventId: inserted.id }
  // The unique index arbitrates concurrent writers. A separate read observes
  // the winning committed row without changing its payload or delivery state.
  const [prior] = await executor.select({ id: coordinatorEvents.id, userId: coordinatorEvents.userId, botId: coordinatorEvents.botId, kind: coordinatorEvents.kind, issueId: coordinatorEvents.issueId, runId: coordinatorEvents.runId, payload: coordinatorEvents.payload })
    .from(coordinatorEvents).where(eq(coordinatorEvents.dedupeKey, dedupeKey)).limit(1)
  if (!prior) throw new Error('personalSubmissionUnavailable')
  if (!submissionId || prior.userId !== userId || prior.botId !== botId || prior.kind !== event.kind || (prior.issueId !== null && !taskDestination) || prior.runId !== null || !isDeepStrictEqual(withoutHostSession(prior.payload), withoutHostSession(event.payload))) throw new SubmissionConflictError()
  return { duplicate: true, eventId: prior.id }
}

/** Byte bound applies even when Content-Length is absent or dishonest. */
export async function readPersonalSubmissionBody(request: Request): Promise<unknown> {
  const declared=request.headers.get('content-length')
  if(declared && Number(declared)>MAX_PERSONAL_SUBMISSION_BYTES) throw new PersonalSubmissionBodyError(413)
  const reader=request.body?.getReader()
  if(!reader)throw new PersonalSubmissionBodyError(400)
  const chunks:Uint8Array[]=[];let size=0
  try{
    while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>MAX_PERSONAL_SUBMISSION_BYTES){await reader.cancel();throw new PersonalSubmissionBodyError(413)}chunks.push(chunk.value)}
  }finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new PersonalSubmissionBodyError(400)}
}
export class PersonalSubmissionBodyError extends Error {
  constructor(readonly status: 400|413){super('personalSubmissionInvalid')}
}

// Replays keep the first immutable provenance. A later session cannot upgrade
// a prior API message to browser authorization or rewrite its original receipt.
function withoutHostSession(payload:Record<string,unknown>){
  const {humanSessionId:_hostSession,...content}=payload
  return content
}
