import 'server-only'
import { cookies } from 'next/headers'
import { activeTaskWorkspaces } from '@/lib/task-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'
import { currentRequestScope } from '@/apps/api/src/context'
import { workspaceSelection } from '@/lib/workspace-selection'

export type RequestWorkspaceUser = { id: string; [tokenWorkspace]?: string; [enterprisePrincipal]?: EnterprisePrincipal }

/** Resolve a verified API request's tenant without creating or changing one.
 * PATs retain their pinned tenant. A browser's selection only narrows freshly
 * checked membership; the cookie never supplies authentication or membership. */
export async function effectiveRequestWorkspace(user: RequestWorkspaceUser): Promise<string | null> {
  const selection = workspaceSelection(currentRequestScope()?.headers)
  if (selection.present && !selection.workspaceId) return null
  const pinned = user[tokenWorkspace]
  if (pinned && selection.present && selection.workspaceId !== pinned) return null
  if (pinned) return (await activeTaskWorkspaces(user, pinned))[0]?.id ?? null
  if (user[enterprisePrincipal]?.kind !== 'session') return null
  const choices = await activeTaskWorkspaces(user)
  if (!choices.length) return null
  if (selection.present) return choices.find(workspace => workspace.id === selection.workspaceId)?.id ?? null
  const selected = (await cookies()).get('mikka-workspace')?.value
  return choices.find(workspace => workspace.id === selected)?.id ?? choices[0].id
}
