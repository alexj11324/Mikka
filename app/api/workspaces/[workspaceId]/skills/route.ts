import { auth,apiWorkspaceAllowed } from '@/lib/api-auth'
import { teamSkillStore,skillAssignments } from '@/lib/self-improvement/server'
import { createTeamSkillHandler } from '@/lib/self-improvement/team-skill-http'
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'

export const dynamic='force-dynamic'
const handle=createTeamSkillHandler({store:teamSkillStore,assignments:skillAssignments,
  async principal(request,workspaceId) {
    const sessionHeaders=humanSessionHeaders(request)
    if(!sessionHeaders)return null
    const session=await auth.api.getSession({headers:sessionHeaders,query:{disableCookieCache:true}})
    return session?.user&&apiWorkspaceAllowed(session,workspaceId)?session.user.id:null
  },
})
type Context={params:Promise<{workspaceId:string}>}
export const GET=async(request:Request,{params}:Context)=>handle(request,(await params).workspaceId)
export const POST=GET
