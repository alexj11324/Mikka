import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerStore } from './store'
import { createComputerHandler } from './handler'

export const computerRoute = createComputerHandler(new ComputerStore(pool), async request => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return null
  const context = await loadWorkspaceContext(undefined, session.user)
  return { userId: session.user.id, workspaceId: context.workspace.id }
})
