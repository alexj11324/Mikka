import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { createOwnedBot } from '@/lib/bot-create'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { loadWorkspaceContext } from '@/lib/workspace-access'

export const dynamic = 'force-dynamic'

/** `POST /api/mobile/bots`: 新建 Bot from the app: `{ name, color, shape }`, in the person's current workspace. */
async function handlePOST(request: Request) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const body = await request.json().catch(() => null) as { name?: unknown; color?: unknown; shape?: unknown } | null
  const workspace = (await loadWorkspaceContext(undefined, user)).workspace
  try {
    return json(await createOwnedBot({ ownerId: user.id, workspaceId: workspace.id }, { name: String(body?.name ?? ''), color: String(body?.color ?? ''), shape: String(body?.shape ?? '') }), 201)
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, error.code === 'botDuplicateName' ? 409 : 400)
    throw error
  }
}

export const POST = withRequestLog('/api/mobile/bots', handlePOST)
