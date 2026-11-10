import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { coordinatorMessages } from '@/lib/db/schema'
import { requestBotChat } from '@/lib/resource-access/request-chat'
import { ActionFailureError } from '@/lib/action-error'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

const query = z.object({ message: z.uuid(), index: z.coerce.number().int().min(0).max(1) })
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/

/**
 * `GET /api/mobile/chat/image?message=<id>&index=<n>`: a photo the person sent
 * in a chat (`images` on a chat item), after current Chat access and message provenance checks.
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const params = query.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!params.success) return json({ error: 'notFound' }, 404)
  // Resolve only identity before authorization. The image bytes and message
  // body are projected after both the Chat ACL and immutable source proof.
  const [identity] = await db.select({ ownerId: coordinatorMessages.userId, botId: coordinatorMessages.botId })
    .from(coordinatorMessages).where(eq(coordinatorMessages.id, params.data.message)).limit(1)
  if (!identity?.botId) return json({ error: 'notFound' }, 404)
  let access: Awaited<ReturnType<typeof requestBotChat>>
  try { access = await requestBotChat(user, identity.botId) } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: 'notFound' }, 404)
    throw error
  }
  if (access.ownerId !== identity.ownerId) return json({ error: 'notFound' }, 404)
  const [row] = await db.select({ message: coordinatorMessages.message }).from(coordinatorMessages)
    .where(and(eq(coordinatorMessages.id, params.data.message), eq(coordinatorMessages.userId, access.ownerId),
      eq(coordinatorMessages.botId, access.id), sql`mikka_bot_chat_display_message_visible(${access.ownerId},${access.id}::uuid,${coordinatorMessages.id},${access.viewerId})`)).limit(1)
  if (!row) return json({ error: 'notFound' }, 404)
  const content = row.message.role === 'user' && Array.isArray(row.message.content) ? row.message.content as { type?: unknown; data?: unknown; mediaType?: unknown }[] : []
  const part = content.filter(item => item.type === 'file' && typeof item.mediaType === 'string' && item.mediaType.startsWith('image/'))[params.data.index]
  const match = typeof part?.data === 'string' ? DATA_URL.exec(part.data) : null
  if (!match) return json({ error: 'notFound' }, 404)
  return new Response(Buffer.from(match[2], 'base64'), {
    headers: { 'content-type': match[1], 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  })
}

export const GET = withRequestLog('/api/mobile/chat/image', handleGET)
