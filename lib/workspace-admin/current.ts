import 'server-only'
import { requireUser } from '@/lib/issue-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'

export interface WorkspaceActor {
  userId: string
  email: string
  name: string
  /** The workspace this request is in (cookie, else the first active membership). */
  workspaceId: string
  role: 'admin' | 'member'
}

/** Who is asking and which workspace they are in. Admin rights are re-checked inside each write transaction. */
export async function currentWorkspaceActor(): Promise<WorkspaceActor> {
  const user = await requireUser()
  const context = await loadWorkspaceContext(undefined, user)
  return { userId: user.id, email: user.email, name: user.name, workspaceId: context.workspace.id, role: context.role }
}
