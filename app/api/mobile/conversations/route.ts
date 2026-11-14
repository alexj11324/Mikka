import { directoryInput } from '@/lib/conversation-directory-input'
import { conversationDirectory } from '@/lib/conversation-directory'
import { pool } from '@/lib/db'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'

export async function GET(request: Request) {
  const user = await mobileUser(request)
  if (!user) return unauthorized()
  const params = new URL(request.url).searchParams
  const workspaceId = await effectiveRequestWorkspace(user)
  if (!workspaceId || params.get('workspaceId') !== workspaceId) return json({ error: 'workspaceAccessDenied' }, 403)
  const pinned = params.get('pinned')
  const archived = params.get('archived')
  if ((pinned !== null && pinned !== 'true' && pinned !== 'false') ||
      (archived !== null && archived !== 'true' && archived !== 'false')) return json({ error: 'invalidInput' }, 422)
  const raw = {
    search: params.get('search') ?? '', state: params.get('state') ?? 'all', archived: archived === 'true',
    botId: params.get('botId') ?? undefined,
    cursor: params.has('after') || params.has('at') || params.has('afterKind') || pinned !== null
      ? { id: params.get('after'), kind: params.get('afterKind') ?? undefined, at: params.get('at'), pinned: pinned === null ? null : pinned === 'true' } : undefined,
  }
  const input = directoryInput.safeParse(raw)
  if (!input.success) return json({ error: 'invalidInput' }, 422)
  return json({ workspaceId, ...await conversationDirectory(pool, user, workspaceId, input.data) })
}
