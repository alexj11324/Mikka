import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { reactionsFor, visibleGroupMessages, REACTIONS, setReaction } from '@/lib/reactions'

export const dynamic = 'force-dynamic'

const input = z.object({ messageId: z.uuid(), emoji: z.enum(REACTIONS).nullable() }).strict()

/** `POST /api/mobile/reactions` with `{ messageId, emoji }`: the person's reaction to a message, or none (`emoji: null`). */
async function handlePOST(request: Request) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const parsed = input.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalidReaction' }, 400)
  if (!await setReaction(user.id, parsed.data.messageId, parsed.data.emoji)) return json({ error: 'notFound' }, 404)
  return json({ ok: true })
}

/**
 * `GET /api/mobile/reactions?ids=<id>,<id>`: reactions on up to 100 group-chat
 * messages (a bot chat's come with it). Only messages in groups the person is
 * still in count; others read as having none.
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const ids = z.array(z.uuid()).max(100).safeParse((new URL(request.url).searchParams.get('ids') ?? '').split(',').filter(Boolean))
  if (!ids.success) return json({ error: 'invalidIds' }, 400)
  return json({ reactions: await reactionsFor(user.id, await visibleGroupMessages(user.id, ids.data)) })
}

export const GET = withRequestLog('/api/mobile/reactions', handleGET)
export const POST = withRequestLog('/api/mobile/reactions', handlePOST)
