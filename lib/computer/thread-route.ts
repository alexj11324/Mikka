import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ThreadDesktopStore } from './thread-desktop'
import { createThreadComputerHandler } from './thread-handler'

export const threadComputerRoute = createThreadComputerHandler(new ThreadDesktopStore(pool), async request => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return null
  const context = await loadWorkspaceContext(undefined, session.user)
  return { userId: session.user.id, workspaceId: context.workspace.id }
})
