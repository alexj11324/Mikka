import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { setChatPreference } from '@/lib/chat-preferences'
import { mobileBot } from '@/lib/mobile-threads'
import { coordinatorBot, openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { botOutsideToken } from '@/lib/tokens/scope'
import { resourceAccessPredicate } from '@/lib/resource-access/predicate'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/bots/<id>`: a bot's page, `coordinator` for the Coordinator: its threads, PRs, scheduled tasks, library and the person's 置顶 / 通知 for it. */
async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const { id } = await context.params
  const workspace = (await loadWorkspaceContext(undefined, user)).workspace
  // `coordinator` names the Coordinator of the workspace the app has open, an ordinary bot row of that workspace.
  if (id === 'coordinator') { const coordinator = await coordinatorBot(user.id, workspace.id); return json(await mobileBot(user, workspace.id, coordinator.botId)) }
  if (!z.uuid().safeParse(id).success) return json({ error: 'Not found' }, 404)
  const [bot] = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, id), eq(bots.workspaceId, workspace.id),
    resourceAccessPredicate(user.id, bots.workspaceId, 'bot', bots.id))).limit(1)
  if (!bot) return json({ error: 'Not found' }, 404)
  return json(await mobileBot(user, workspace.id, bot.id))
}

const change = z.object({ pinned: z.boolean().optional(), muted: z.boolean().optional(), hidden: z.boolean().optional(), markedUnread: z.boolean().optional() })
  .strict().refine(value => Object.values(value).some(field => field !== undefined))

/**
 * `PATCH /api/mobile/bots/<id>` with `{ pinned?, muted?, hidden?, markedUnread? }`: the person's own state for this chat
 * (`coordinator` too): 置顶, 通知, hidden from the home list, marked unread. 409 `pinLimit` when the pins are full.
 */
async function handlePATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const { id } = await context.params
  const body = change.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidChange' }, 400)
  if (id !== 'coordinator' && (!z.uuid().safeParse(id).success || await botOutsideToken(user, id))) return json({ error: 'Not found' }, 404)
  const result = await setChatPreference(user.id, await openChatBotId(user, id === 'coordinator' ? null : id), body.data)
  if (result === 'notFound') return json({ error: 'Not found' }, 404)
  if (result === 'pinLimit') return json({ error: 'pinLimit' }, 409)
  return json({ ok: true })
}

export const GET = withRequestLog('/api/mobile/bots/[id]', handleGET)
export const PATCH = withRequestLog('/api/mobile/bots/[id]', handlePATCH)
