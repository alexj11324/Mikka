import { interopApi, interopBody, limitParam, sendKey } from '@/lib/interop/http'
import { readBotChat, sendToBot } from '@/lib/interop/bots'

type Context = { params: Promise<{ botId: string }> }

/** The latest messages of the Bot owner's chat with this Bot, when shared. */
export const GET = async (request: Request, { params }: Context) => {
  const { botId } = await params
  return interopApi(request, 'bots:read', principal => readBotChat(principal, botId, limitParam(request)))
}

/** Hand the Bot a peer message and wake it for a turn. */
export const POST = async (request: Request, { params }: Context) => {
  const { botId } = await params
  return interopApi(request, 'bots:write', async principal => {
    const body = await interopBody(request)
    return sendToBot(principal, { botId, text: body.text as string, key: sendKey(request, body) as string })
  }, 202)
}
