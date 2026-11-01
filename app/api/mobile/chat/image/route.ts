import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { bots, coordinatorMessages } from '@/lib/db/schema'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

const query = z.object({ message: z.uuid(), index: z.coerce.number().int().min(0).max(1) })
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/

/**
 * `GET /api/mobile/chat/image?message=<id>&index=<n>`: a photo the person sent
 * in a chat (`images` on a chat item), from their own stored message only.
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const params = query.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!params.success) return json({ error: 'notFound' }, 404)
  const [row] = await db.select({ message: coordinatorMessages.message, botId: coordinatorMessages.botId }).from(coordinatorMessages)
    .where(and(eq(coordinatorMessages.id, params.data.message), eq(coordinatorMessages.userId, user.id))).limit(1)
  if (!row) return json({ error: 'notFound' }, 404)
  // A token bound to a workspace reads only its own bots' chats, as the chat route does.
  const workspace = (user as { [tokenWorkspace]?: string })[tokenWorkspace]
  if (workspace && row.botId) {
    const [bot] = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, row.botId), eq(bots.workspaceId, workspace))).limit(1)
    if (!bot) return json({ error: 'notFound' }, 404)
  }
  const content = row.message.role === 'user' && Array.isArray(row.message.content) ? row.message.content as { type?: unknown; data?: unknown; mediaType?: unknown }[] : []
  const part = content.filter(item => item.type === 'file' && typeof item.mediaType === 'string' && item.mediaType.startsWith('image/'))[params.data.index]
  const match = typeof part?.data === 'string' ? DATA_URL.exec(part.data) : null
  if (!match) return json({ error: 'notFound' }, 404)
  return new Response(Buffer.from(match[2], 'base64'), {
    headers: { 'content-type': match[1], 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
  })
}

export const GET = withRequestLog('/api/mobile/chat/image', handleGET)
