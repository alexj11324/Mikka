import { after } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { chatView } from '@/lib/coordinator/store'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { recordPersonalSubmission, SubmissionConflictError } from '@/lib/coordinator-submission'
import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { getCoordinatorChat, sendCoordinatorMessage } from '@/app/actions/coordinator'
import { ActionFailureError } from '@/lib/action-error'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { MESSAGE_MAX } from '@/lib/message-limits'
import { userImageInputsSchema } from '@/lib/coordinator/user-attachments'

export const dynamic = 'force-dynamic'

const botParam = z.uuid().nullable()

/** Only PATs need an additional bound-workspace fence; browser actions retain their own checks. */
async function tokenBotAllowed(user: { id: string; [tokenWorkspace]?: string }, botId: string | null) {
  if (!botId || !user[tokenWorkspace]) return true
  const [bot] = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, user.id), eq(bots.workspaceId, user[tokenWorkspace]!))).limit(1)
  return Boolean(bot)
}

/** `GET /api/mobile/chat?bot=<id>`: the chat with the Coordinator (no `bot`) or one of the person's bots. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const bot = botParam.safeParse(new URL(request.url).searchParams.get('bot'))
  if (!bot.success) return json({ error: 'invalidBot' }, 400)
  try {
    if (typeof user[tokenWorkspace] === 'string') {
      if (!await tokenBotAllowed(user, bot.data)) return json({ error: 'botNotFound' }, 404)
      const enabled = coordinatorEnabled()
      const chat = await chatView(user.id, 200, bot.data)
      return json({ ...chat, enabled, working: enabled && chat.working })
    }
    return json(await getCoordinatorChat(bot.data))
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, 404)
    throw error
  }
}

/** `POST /api/mobile/chat` with `{ text, botId?, images? }`: a message, with up to two photos as data URLs; the reply shows up in the chat. */
async function handlePOST(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const parsed = z.object({ text: z.string().trim().max(MESSAGE_MAX), botId: z.uuid().nullable().optional(), images: userImageInputsSchema.optional() })
    .refine(value => Boolean(value.text || value.images?.length)).safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'messageRequired' }, 400)
  const images = parsed.data.images?.length ? parsed.data.images : undefined
  if (typeof user[tokenWorkspace] === 'string') {
    const botId = parsed.data.botId ?? null
    if (!await tokenBotAllowed(user, botId)) return json({ error: 'botNotFound' }, 404)
    try { await recordPersonalSubmission(db, user.id, parsed.data.text, { botId, images }) }
    catch (error) {
      if (error instanceof SubmissionConflictError) return json({ error: 'submissionConflict' }, 409)
      throw error
    }
    after(() => wakeCoordinator(user.id))
    return json({ queued: true }, 202)
  }
  const result = await sendCoordinatorMessage(parsed.data.text, null, parsed.data.botId ?? null, undefined, undefined, null, images)
  return result.error ? json(result, 400) : json(result, 202)
}

export const GET = withRequestLog('/api/mobile/chat', handleGET)
export const POST = withRequestLog('/api/mobile/chat', handlePOST)
