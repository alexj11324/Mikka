import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { getCoordinatorChat, sendCoordinatorMessage } from '@/app/actions/coordinator'
import { ActionFailureError } from '@/lib/action-error'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { MESSAGE_MAX } from '@/lib/message-limits'

export const dynamic = 'force-dynamic'

const botParam = z.uuid().nullable()

/** `GET /api/mobile/chat?bot=<id>`: the chat with the Coordinator (no `bot`) or one of the person's bots. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const bot = botParam.safeParse(new URL(request.url).searchParams.get('bot'))
  if (!bot.success) return json({ error: 'invalidBot' }, 400)
  try {
    return json(await getCoordinatorChat(bot.data))
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, 404)
    throw error
  }
}

/** `POST /api/mobile/chat` with `{ text, botId? }`: a message; the reply shows up in the chat. */
async function handlePOST(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const parsed = z.object({ text: z.string().trim().min(1).max(MESSAGE_MAX), botId: z.uuid().nullable().optional() }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'messageRequired' }, 400)
  const result = await sendCoordinatorMessage(parsed.data.text, null, parsed.data.botId ?? null)
  return result.error ? json(result, 400) : json(result, 202)
}

export const GET = withRequestLog('/api/mobile/chat', handleGET)
export const POST = withRequestLog('/api/mobile/chat', handlePOST)
