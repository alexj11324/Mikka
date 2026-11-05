import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { setGroupPreference } from '@/lib/chat-preferences'
import { groupOutsideToken } from '@/lib/tokens/scope'

export const dynamic = 'force-dynamic'

const change = z.object({ pinned: z.boolean().optional(), hidden: z.boolean().optional(), markedUnread: z.boolean().optional() })
  .strict().refine(value => Object.values(value).some(field => field !== undefined))

/**
 * `PATCH /api/mobile/groups/<id>` with `{ pinned?, hidden?, markedUnread? }`: the person's own state for a group chat
 * they are in, on the home list. 409 `pinLimit` when the pins are full.
 */
async function handlePATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const { id } = await context.params
  const body = change.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidChange' }, 400)
  if (!z.uuid().safeParse(id).success || await groupOutsideToken(user, id)) return json({ error: 'Not found' }, 404)
  const result = await setGroupPreference(user.id, id, body.data)
  if (result === 'notFound') return json({ error: 'Not found' }, 404)
  if (result === 'pinLimit') return json({ error: 'pinLimit' }, 409)
  return json({ ok: true })
}

export const PATCH = withRequestLog('/api/mobile/groups/[id]', handlePATCH)
