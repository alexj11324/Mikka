import { z } from 'zod'
import { requestBotChat } from '@/lib/resource-access/request-chat'
import { ActionFailureError } from '@/lib/action-error'
import { stopChatTurn } from '@/lib/coordinator/stop-turn'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

/** Stop this exact Chat with current tenant, principal and steering authority. */
async function handlePOST(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const parsed = z.object({ botId: z.uuid().nullable().optional() }).strict().safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return json({ error: 'invalidBot' }, 400)
  try {
    const access = await requestBotChat(user, parsed.data.botId, 'canSteer')
    return json({ stopped: await stopChatTurn(access.ownerId, access.id, undefined, { reader: access.reader, reference: access.reference }) })
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, error.code === 'authRequired' ? 401 : 404)
    throw error
  }
}

export const POST = withRequestLog('/api/mobile/chat/stop', handlePOST)
