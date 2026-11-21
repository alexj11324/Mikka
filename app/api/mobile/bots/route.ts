import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { createOwnedBot } from '@/lib/bot-create'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { workVisibilitySchema } from '@mikka/protocol/work-visibility'


/** `POST /api/mobile/bots`: create a Bot in the person's current workspace, with optional visibility. */
async function handlePOST(request: Request) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const body = await request.json().catch(() => null) as { name?: unknown; color?: unknown; shape?: unknown; visibility?: unknown } | null
  const visibility = workVisibilitySchema.optional().safeParse(body?.visibility)
  if (!visibility.success) return json({ error: 'validationGeneric' }, 400)
  const workspace = (await loadWorkspaceContext(undefined, user)).workspace
  try {
    return json(await createOwnedBot({ ownerId: user.id, workspaceId: workspace.id }, { name: String(body?.name ?? ''), color: String(body?.color ?? ''), shape: String(body?.shape ?? ''), visibility: visibility.data }), 201)
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, error.code === 'botDuplicateName' ? 409 : 400)
    throw error
  }
}

export const POST = withRequestLog('/api/mobile/bots', handlePOST)
