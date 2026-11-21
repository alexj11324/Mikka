import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { mobileThreadArtifacts } from '@/lib/mobile-thread-artifacts'
import { runOutsideToken } from '@/lib/tokens/scope'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { workspaceSelection } from '@/lib/workspace-selection'


/**
 * `GET /api/mobile/threads/:id/artifacts`: the thread's Artifact segment on iOS (方案 / PR / 报告 / 截图和录屏), as the
 * web's Artifact tab lists it. Only the person's own thread, within the selected workspace; anything else is 404.
 */
async function handleGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success || await runOutsideToken(user, id.data)) return json({ error: 'runNotFound' }, 404)
  try {
    const selectedWorkspaceId = workspaceSelection(request.headers).present
      ? (await loadWorkspaceContext(undefined, user)).workspace.id : undefined
    const found = await mobileThreadArtifacts(user, id.data, selectedWorkspaceId)
    return found ? json(found) : json({ error: 'runNotFound' }, 404)
  } catch (error) {
    if (error instanceof WorkspaceError) return json({ error: 'runNotFound' }, 404)
    throw error
  }
}

export const GET = withRequestLog('/api/mobile/threads/[id]/artifacts', handleGET)
