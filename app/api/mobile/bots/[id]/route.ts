import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { setChatPreference } from '@/lib/chat-preferences'
import { mobileBot } from '@/lib/mobile-threads'
import { loadWorkspaceContext } from '@/lib/workspace-access'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/bots/<id>`: a bot's page, `coordinator` for the Coordinator: its threads, PRs, scheduled tasks, library and the person's 置顶 / 通知 for it. */
async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const { id } = await context.params
  const workspace = (await loadWorkspaceContext(undefined, user)).workspace
  if (id === 'coordinator') return json(await mobileBot(user.id, workspace.id, null))
  if (!z.uuid().safeParse(id).success) return json({ error: 'Not found' }, 404)
  const [bot] = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, id), eq(bots.ownerId, user.id), eq(bots.workspaceId, workspace.id))).limit(1)
  if (!bot) return json({ error: 'Not found' }, 404)
  return json(await mobileBot(user.id, workspace.id, bot.id))
}

const change = z.object({ pinned: z.boolean().optional(), muted: z.boolean().optional() }).strict().refine(value => value.pinned !== undefined || value.muted !== undefined)

/** `PATCH /api/mobile/bots/<id>` with `{ pinned?, muted? }`: the person's 置顶 and 通知 for this chat (`coordinator` too). */
async function handlePATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const { id } = await context.params
  const body = change.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidChange' }, 400)
  if (id !== 'coordinator' && !z.uuid().safeParse(id).success) return json({ error: 'Not found' }, 404)
  if (!await setChatPreference(user.id, id === 'coordinator' ? null : id, body.data)) return json({ error: 'Not found' }, 404)
  return json({ ok: true })
}

export const GET = withRequestLog('/api/mobile/bots/[id]', handleGET)
export const PATCH = withRequestLog('/api/mobile/bots/[id]', handlePATCH)
