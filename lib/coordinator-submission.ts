import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { normalizeUserImages, userImageInputsSchema, MAX_PERSONAL_SUBMISSION_BYTES, type UserImageInput } from './coordinator/user-attachments'
import { coordinatorEvents } from './db/schema'
import type { db } from './db'

/** Personal Coordinator HTTP contract. Question/approval fields are not supported. */
export const personalSubmissionInput = z.object({
  text: z.string().trim().max(10_000).default(''),
  images: userImageInputsSchema.optional(),
  submissionId: z.uuid().transform(value => value.toLowerCase()).optional(),
}).strict().refine(value => Boolean(value.text || value.images?.length), {message:'messageRequired'})

export class SubmissionConflictError extends Error {
  constructor() { super('submissionConflict') }
}

type Executor = Pick<typeof db, 'insert' | 'select'>

/** Caller authenticates the person and validates any Bot ownership before calling. */
export async function recordPersonalSubmission(executor: Executor, userId: string, text: string, options: { submissionId?: string; botId?: string | null; images?: readonly UserImageInput[] } = {}) {
  const submissionId = personalSubmissionInput.shape.submissionId.parse(options.submissionId)
  const botId = options.botId ?? null
  const images = normalizeUserImages(options.images)
  const dedupeKey = submissionId
    ? `personal_submission:v1:${createHash('sha256').update(JSON.stringify([userId, botId, submissionId])).digest('hex')}`
    : `user_message:${randomUUID()}`
  const event = { userId, botId, kind: 'user_message' as const, dedupeKey, issueId: null, runId: null, payload: { text, ...(images.length ? {images} : {}) } }
  const [inserted] = await executor.insert(coordinatorEvents).values({ id: randomUUID(), ...event })
    .onConflictDoNothing({ target: coordinatorEvents.dedupeKey }).returning({ id: coordinatorEvents.id })
  if (inserted) return { duplicate: false }
  // The unique index arbitrates concurrent writers. A separate read observes
  // the winning committed row without changing its payload or delivery state.
  const [prior] = await executor.select({ userId: coordinatorEvents.userId, botId: coordinatorEvents.botId, kind: coordinatorEvents.kind, issueId: coordinatorEvents.issueId, runId: coordinatorEvents.runId, payload: coordinatorEvents.payload })
    .from(coordinatorEvents).where(eq(coordinatorEvents.dedupeKey, dedupeKey)).limit(1)
  if (!prior) throw new Error('personalSubmissionUnavailable')
  if (!submissionId || prior.userId !== userId || prior.botId !== botId || prior.kind !== event.kind || prior.issueId !== null || prior.runId !== null || !isDeepStrictEqual(prior.payload, event.payload)) throw new SubmissionConflictError()
  return { duplicate: true }
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
