import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { mobileBot } from '@/lib/mobile-threads'
import { loadWorkspaceContext } from '@/lib/workspace-access'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/bots/<id>`: a bot's page, `coordinator` for the Coordinator: its threads, PRs and scheduled tasks. */
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

export const GET = withRequestLog('/api/mobile/bots/[id]', handleGET)
