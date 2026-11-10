import 'server-only'
import type { IssueReader } from '@/lib/issue-visibility'
import { ActionFailureError } from '@/lib/action-error'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { chatBotId } from '@/lib/coordinator/coordinator-bot'
import type { ResourceAction } from './contract'
import { authorizedBotChat } from './chat'

/** All HTTP chat surfaces bind to the request's selected tenant and preserve
 * its non-enumerable Session/PAT/OAuth principal. A supplied Bot id is only a
 * locator, never a Workspace selection or structural Owner assertion. */
export async function requestBotChat(user: Exclude<IssueReader, string>, botId: string | null | undefined,
  action: ResourceAction = 'canReadContent') {
  const workspaceId = await effectiveRequestWorkspace(user)
  if (!workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  const reader = { id: user.id, [tokenWorkspace]: workspaceId, [enterprisePrincipal]: user[enterprisePrincipal] }
  const id = await chatBotId(user.id, botId, workspaceId)
  return authorizedBotChat(reader, id, action, workspaceId)
}
