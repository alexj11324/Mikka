import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { NextResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/api-auth'
import { chatView } from '@/lib/coordinator/store'
import * as chatStore from '@/lib/coordinator/store'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { coordinatorEnabled } from '@/lib/coordinator/wake'


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
  const enabled = await coordinatorEnabled(session.user.id, botId)
  const state = { ...current, working: enabled && current.working, enabled, botId }
  const etag = `"${createHash('sha256').update(JSON.stringify([session.user.id, botId, state])).digest('hex')}"`
  const headers = { 'Cache-Control': 'private, no-store', ETag: etag, Vary: 'Cookie, Authorization' }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  if (params.get('known') === current.version) return NextResponse.json({ unchanged: true, ...state }, { headers })
  const chat = cursor.success ? await chatStore.chatUpdate(session.user.id, botId, cursor.data) : await chatView(session.user.id, 200, botId)
  return NextResponse.json({ ...chat, ...state }, { headers })
}

export const GET = withRequestLog('/api/coordinator/messages', handleGET)
export const POST = withRequestLog('/api/coordinator/messages', () =>
  Response.json({ error: 'coordinatorSendRetired' }, { status: 410, headers: { 'Cache-Control': 'no-store' } }))
