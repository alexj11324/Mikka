import { ChatFileError } from '@/lib/chat-attachments/extract'
import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { NextResponse } from 'next/server'
import { afterJob } from '@/lib/background'
import { auth } from '@/lib/api-auth'
import { db, pool } from '@/lib/db'
import { personalSubmissionInput, recordPersonalSubmission, SubmissionConflictError, readPersonalSubmissionBody, PersonalSubmissionBodyError } from '@/lib/coordinator-submission'
import { chatView } from '@/lib/coordinator/store'
import * as chatStore from '@/lib/coordinator/store'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { requestBotChat } from '@/lib/resource-access/request-chat'
import { ActionFailureError } from '@/lib/action-error'
import { botChatContributionPolicy, botChatOwnerExclusive, submitBotChatMessage } from '@/lib/collaboration/bot-chat'
import { writeAllowed, forbiddenOrigin } from '@/lib/mobile-api'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'

export const dynamic = 'force-dynamic'

/** `GET /api/coordinator/messages`: the person's conversation with their Coordinator, oldest first. */
async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const params = new URL(request.url).searchParams
  const requestedBot = z.uuid().nullable().safeParse(params.get('botId'))
  if (!requestedBot.success) return NextResponse.json({ error: 'botNotFound' }, { status: 404 })
  const access = await requestBotChat(session.user, requestedBot.data)
  const botId = access.id
  if (params.get('policy') === '1') return NextResponse.json(await botChatContributionPolicy(access.reader, botId), { headers: { 'Cache-Control': 'private, no-store' } })
  const cursor = z.object({ after: z.coerce.number().int().min(0).max(2147483647), cursor: z.coerce.number().int().min(0).max(2147483647), prefix: z.string().regex(/^[0-9a-f]{32}$/) })
    .safeParse({ after: params.get('after'), cursor: params.get('cursor'), prefix: params.get('prefix') })
  if (params.has('after') && !cursor.success) return NextResponse.json({ error: 'validationGeneric' }, { status: 400 })
  const current = await chatStore.chatVersion(access.ownerId, 200, botId, access.reader)
  const enabled = await coordinatorEnabled(access.ownerId, botId)
  const state = { ...current, working: enabled && current.working, enabled, botId }
  const etag = `"${createHash('sha256').update(JSON.stringify([session.user.id, botId, state])).digest('hex')}"`
  const headers = { 'Cache-Control': 'private, no-store', ETag: etag, Vary: 'Cookie, Authorization' }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  if (params.get('known') === current.version) return NextResponse.json({ unchanged: true, ...state }, { headers })
  const chat = cursor.success ? await chatStore.chatUpdate(access.ownerId, botId, cursor.data, access.reader) : await chatView(access.ownerId, 200, botId, {}, access.reader)
  return NextResponse.json({ ...chat, ...state }, { headers })
}

/**
 * `POST /api/coordinator/messages` with `{ text?, images?: [{dataUrl}], submissionId? }`: a message to the
 * Coordinator. It lands in the inbox and wakes a turn; the reply shows up in
 * the conversation.
 */
async function handlePOST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  if (!writeAllowed(request)) return forbiddenOrigin()
  let body:unknown
  try{body=await readPersonalSubmissionBody(request)}catch(error){if(error instanceof PersonalSubmissionBodyError)return NextResponse.json({error:'messageRequired'},{status:error.status});throw error}
  const parsed = personalSubmissionInput.safeExtend({ botId: z.uuid().nullable().optional(), mode: z.enum(['comment','reply']).optional() }).safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'messageRequired' }, { status: 400 })
  const userId = session.user.id
  // A message enters the Coordinator chat of the workspace it was sent in (a token's own workspace): resolved here.
  const access = await requestBotChat(session.user, parsed.data.botId)
  const botId = access.id
  try {
    if (parsed.data.mode === 'comment' || !await botChatOwnerExclusive(pool, access.ownerId, botId)) {
      if (!parsed.data.submissionId) throw new ActionFailureError('validationGeneric')
      const result = await submitBotChatMessage(access.reader, botId, { text: parsed.data.text, images: parsed.data.images,
        submissionId: parsed.data.submissionId, mode: parsed.data.mode ?? 'reply' })
      return NextResponse.json({ ...result, accepted: true, enabled: await coordinatorEnabled(access.ownerId, botId) }, { status: 202 })
    }
    if (access.ownerId !== userId) throw new ActionFailureError('workspaceAccessDenied')
    await recordPersonalSubmission(db, userId, parsed.data.text, { botId, submissionId: parsed.data.submissionId, images:parsed.data.images, ...(!request.headers.has('authorization')&&request.headers.get('cookie')&&request.headers.get('origin')===new URL(request.url).origin?{humanSessionId:session.session.id}:{}) })
  }
  catch (error) {
    if (error instanceof ActionFailureError) return NextResponse.json({ error: error.code }, { status: error.code === 'authRequired' ? 401 : 403 })
    if (error instanceof ChatFileError) return Response.json({ error: error.code }, { status: error.code === 'notFound' ? 404 : 400 })
    if (error instanceof SubmissionConflictError) return NextResponse.json({ error: 'submissionConflict' }, { status: 409 })
    throw error
  }
  afterJob('after:coordinator-wake', () => wakeCoordinator(userId))
  return NextResponse.json({ queued: true, enabled: await coordinatorEnabled(userId, botId) }, { status: 202 })
}

const guarded = (work: (request: Request) => Promise<Response>) => async (request: Request) => {
  try { return await work(request) } catch (error) {
    if (error instanceof ActionFailureError) return NextResponse.json({ error: error.code }, { status: error.code === 'authRequired' ? 401 : 404 })
    throw error
  }
}
export const GET = withRequestLog('/api/coordinator/messages', guarded(handleGET))
export const POST = withRequestLog('/api/coordinator/messages', guarded(handlePOST))
