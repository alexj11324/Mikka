import { auth,apiWorkspaceAllowed } from '@/lib/api-auth'
import { teamSkillStore,skillAssignments } from '@/lib/self-improvement/server'
import { createTeamSkillHandler } from '@/lib/self-improvement/team-skill-http'

export const dynamic='force-dynamic'
const handle=createTeamSkillHandler({store:teamSkillStore,assignments:skillAssignments,
  async principal(request,workspaceId) {
    if(!request.headers.get('cookie')||request.headers.has('authorization'))return null
    const session=await auth.api.getSession({headers:request.headers,query:{disableCookieCache:true}})
    return session?.user&&apiWorkspaceAllowed(session,workspaceId)?session.user.id:null
  },
})
type Context={params:Promise<{workspaceId:string}>}
export const GET=async(request:Request,{params}:Context)=>handle(request,(await params).workspaceId)
export const POST=GET
