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

/**
 * Who is asking and which workspace they are in. Settings pages pass the
 * workspace they show (`?workspace=`) so a write never lands in the cookie's
 * workspace instead; membership is checked either way. Admin rights are
 * re-checked inside each write transaction.
 */
export async function currentWorkspaceActor(workspaceId?: string): Promise<WorkspaceActor> {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId || undefined, user)
  return { userId: user.id, email: user.email, name: user.name, workspaceId: context.workspace.id, role: context.role }
}
