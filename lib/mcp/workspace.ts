import 'server-only'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { actAs } from '@/lib/acting-user'
import { ActionFailureError } from '@/lib/action-error'
import { requireTaskWorkspace } from '@/lib/task-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { mcpEnterprisePrincipal, mcpUserId } from './auth'
import { enterprisePrincipal } from '@/lib/enterprise/principal'

/** OAuth requests select a tenant; a scoped token cannot override its pin. */
export async function withMcpWorkspace<T>(auth: AuthInfo | undefined, requestedId: string | undefined, work: (userId: string) => Promise<T>): Promise<T> {
  const userId = mcpUserId(auth)
  const pinned = typeof auth?.extra?.workspaceId === 'string' ? auth.extra.workspaceId : undefined
  const workspaceId = requestedId ?? pinned
  if (!workspaceId || pinned && pinned !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  const principal = { id: userId, [tokenWorkspace]: workspaceId, [enterprisePrincipal]: mcpEnterprisePrincipal(auth) }
  await requireTaskWorkspace(principal, workspaceId)
  return actAs(principal, () => work(userId))
}
