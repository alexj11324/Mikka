import { z } from 'zod'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { changeThreadRead } from '@/lib/thread-reads'

const change = z.discriminatedUnion('action', [
  z.object({ action: z.literal('unread'), runId: z.uuid() }),
  z.object({ action: z.literal('read'), runId: z.uuid(), through: z.iso.datetime().nullable(), revision: z.number().int().nonnegative() }),
  z.object({ action: z.literal('readAll') }),
])

export async function POST(request: Request) {
  const user = await mobileUser(request)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const parsed = change.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalidInput' }, 422)
  const workspaceId = await effectiveRequestWorkspace(user)
  if (!workspaceId || !await changeThreadRead(user, workspaceId, parsed.data)) return json({ error: 'conversationNotFound' }, 404)
  return json({ ok: true })
}
