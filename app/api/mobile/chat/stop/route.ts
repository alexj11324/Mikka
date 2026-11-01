import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { chatBotId } from '@/lib/coordinator/coordinator-bot'
import { stopChatTurn } from '@/lib/coordinator/stop-turn'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

/** `POST /api/mobile/chat/stop` with `{ botId? }`: 停止 the turn working in the chat with the Coordinator (no `botId`) or one of the person's bots. */
async function handlePOST(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const parsed = z.object({ botId: z.uuid().nullable().optional() }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return json({ error: 'invalidBot' }, 400)
  const botId = parsed.data.botId ?? null
  if (botId) {
    // Only the person's own bot; a token bound to a workspace reaches that workspace's bots only.
    const workspace = typeof user[tokenWorkspace] === 'string' ? user[tokenWorkspace] : null
    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, user.id), ...(workspace ? [eq(bots.workspaceId, workspace)] : []))).limit(1)
    if (!bot) return json({ error: 'botNotFound' }, 404)
  }
  return json({ stopped: await stopChatTurn(user.id, await chatBotId(user.id, botId)) })
}

export const POST = withRequestLog('/api/mobile/chat/stop', handlePOST)
