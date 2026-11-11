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
  // Cookie-less native clients use the Workspace header. Browser cookies are
  // the same exact preference here; stale/foreign cookies must not fall home.
  if(!context.headers.has('x-mikka-workspace-id')) {
    const cookie=context.cookies.get('mikka-workspace')
    if(cookie)context.headers.set('x-mikka-workspace-id',cookie.value)
  }
  return runRequestScope(context,async()=>{
    const {loadWorkspaceContext,WorkspaceError}=await import('../workspace-access')
    try {
      const {openChatBotId}=await import('../coordinator/coordinator-bot')
      const botId=parsed?.success?parsed.data.toLowerCase():await openChatBotId(session.user,null)
      const workspace=(await loadWorkspaceContext(undefined,session.user)).workspace.id
      const {pool}=await import('../db')
      const bot=(await pool.query<{workspaceId:string}>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3',[botId,session.user.id,workspace])).rows[0]
      return bot?{botId,workspaceId:bot.workspaceId}:null
    }catch(error){if(error instanceof WorkspaceError)return null;throw error}
  })
}
