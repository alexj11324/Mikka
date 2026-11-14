import type {ApiSession} from '../api-auth'
import {createRequestScope,runRequestScope} from '../../apps/api/src/context'

/** Resolve default Coordinator exactly as the app does, using this request's
 * active Workspace. A supplied invalid selector never becomes a default. */
export async function resolveEveRequestBot(request:Request,session:ApiSession) {
  const {z}=await import('zod')
  const supplied=new URL(request.url).searchParams.get('botId')??request.headers.get('x-mikka-bot-id')
  const parsed=supplied===null?null:z.uuid().safeParse(supplied)
  if(parsed&&!parsed.success)return null
  const context=createRequestScope(request)
  // Reuse the app's selection policy: an explicit header is exact, while a
  // stale browser preference falls back to the person's own Workspace.
  return runRequestScope(context,async()=>{
    const {loadWorkspaceContext,WorkspaceError}=await import('../workspace-access')
    try {
      const { chatBotId } = await import('../coordinator/coordinator-bot')
      const workspace = (await loadWorkspaceContext(undefined, session.user)).workspace.id
      const botId = await chatBotId(session.user.id, parsed?.data?.toLowerCase(), workspace)
      const { apiWorkspaceAllowed } = await import('../api-auth')
      if (!apiWorkspaceAllowed(session, workspace)) return null
      const { assertEveScope } = await import('./scope')
      await assertEveScope({ ownerId: session.user.id, botId, workspaceId: workspace, surface: 'web' })
      return {botId,workspaceId:workspace}
    } catch (error) {
      if (error instanceof WorkspaceError || (error instanceof Error && error.message === 'botNotFound')) return null
      throw error
    }
  })
}
