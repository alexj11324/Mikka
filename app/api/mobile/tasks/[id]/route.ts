import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { mobileTask } from '@/lib/mobile-tasks'

export const dynamic = 'force-dynamic'

/** Read one task and its attempts; raw run errors remain on /api/mobile/threads/:id. */
async function handleGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'issueNotFound' }, 404)
  try {
    const { workspace } = await loadWorkspaceContext(undefined, user)
    const detail = await mobileTask(user, workspace, id.data)
    return detail ? json(detail) : json({ error: 'issueNotFound' }, 404)
  } catch (error) {
    if (error instanceof WorkspaceError) return json({ error: 'issueNotFound' }, 404)
    throw error
  }
}

export const GET = withRequestLog('/api/mobile/tasks/[id]', handleGET)
