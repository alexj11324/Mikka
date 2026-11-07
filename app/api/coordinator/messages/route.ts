import { ChatFileError } from '@/lib/chat-attachments/extract'
import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { NextResponse } from 'next/server'
import { afterJob } from '@/lib/background'
import { auth } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { personalSubmissionInput, recordPersonalSubmission, SubmissionConflictError, readPersonalSubmissionBody, PersonalSubmissionBodyError } from '@/lib/coordinator-submission'
import { chatView } from '@/lib/coordinator/store'
import * as chatStore from '@/lib/coordinator/store'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'

export const dynamic = 'force-dynamic'

/** `GET /api/coordinator/messages`: the person's conversation with their Coordinator, oldest first. */
async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const botId = await openChatBotId(session.user, null)
  const params = new URL(request.url).searchParams
  const cursor = z.object({ after: z.coerce.number().int().min(0).max(2147483647), cursor: z.coerce.number().int().min(0).max(2147483647), prefix: z.string().regex(/^[0-9a-f]{32}$/) })
    .safeParse({ after: params.get('after'), cursor: params.get('cursor'), prefix: params.get('prefix') })
  if (params.has('after') && !cursor.success) return NextResponse.json({ error: 'validationGeneric' }, { status: 400 })
  const current = await chatStore.chatVersion(session.user.id, 200, botId)
  const enabled = await coordinatorEnabled(session.user.id)
  const state = { ...current, working: enabled && current.working, enabled, botId }
  const etag = `"${createHash('sha256').update(JSON.stringify([session.user.id, botId, state])).digest('hex')}"`
  const headers = { 'Cache-Control': 'private, no-store', ETag: etag, Vary: 'Cookie, Authorization' }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  if (params.get('known') === current.version) return NextResponse.json({ unchanged: true, ...state }, { headers })
  const chat = cursor.success ? await chatStore.chatUpdate(session.user.id, botId, cursor.data) : await chatView(session.user.id, 200, botId)
  return NextResponse.json({ ...chat, ...state }, { headers })
}

/**
 * `POST /api/coordinator/messages` with `{ text?, images?: [{dataUrl}], submissionId? }`: a message to the
 * Coordinator. It lands in the inbox and wakes a turn; the reply shows up in
 * the conversation.
 */
async function handlePOST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  let body:unknown
  try{body=await readPersonalSubmissionBody(request)}catch(error){if(error instanceof PersonalSubmissionBodyError)return NextResponse.json({error:'messageRequired'},{status:error.status});throw error}
  const parsed = personalSubmissionInput.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'messageRequired' }, { status: 400 })
  const userId = session.user.id
  // A message enters the Coordinator chat of the workspace it was sent in (a token's own workspace): resolved here.
  const botId = await openChatBotId(session.user, null)
  try { await recordPersonalSubmission(db, userId, parsed.data.text, { botId, submissionId: parsed.data.submissionId, images:parsed.data.images, ...(!request.headers.has('authorization')&&request.headers.get('cookie')&&request.headers.get('origin')===new URL(request.url).origin?{humanSessionId:session.session.id}:{}) }) }
  catch (error) {
    if (error instanceof ChatFileError) return Response.json({ error: error.code }, { status: error.code === 'notFound' ? 404 : 400 })
    if (error instanceof SubmissionConflictError) return NextResponse.json({ error: 'submissionConflict' }, { status: 409 })
    throw error
  }
  afterJob('after:coordinator-wake', () => wakeCoordinator(userId))
  return NextResponse.json({ queued: true, enabled: await coordinatorEnabled(userId) }, { status: 202 })
}

export const GET = withRequestLog('/api/coordinator/messages', handleGET)
export const POST = withRequestLog('/api/coordinator/messages', handlePOST)
