import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { withRequestLog } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { json,writeAllowed,forbiddenOrigin,unauthorized } from '@/lib/mobile-api'
import { resourceReferenceInput,resourceAccessChangeSchema } from '@/lib/resource-access/input'
import { resourceAccessView } from '@/lib/resource-access/view'
import { changeResourceAccess } from '@/lib/resource-access/store'

export const dynamic='force-dynamic'
type Params={params:Promise<{kind:string;id:string}>}
async function handle(request:Request,params:Params) {
  const session=await auth.api.getSession({headers:request.headers,query:{disableCookieCache:true}})
  if(!session)return unauthorized()
  if(request.method!=='GET'&&!writeAllowed(request))return forbiddenOrigin()
  const workspaceId=await effectiveRequestWorkspace(session.user)
  const parsed=resourceReferenceInput.safeParse({...await params.params,workspaceId})
  if(!parsed.success)return json({error:'issueNotFound'},404)
  const reader={...session.user,[tokenWorkspace]:parsed.data.workspaceId,[enterprisePrincipal]:session.user[enterprisePrincipal]}
  try {
    if(request.method!=='GET')await changeResourceAccess(reader,parsed.data,resourceAccessChangeSchema.parse(await request.json().catch(()=>null)))
    return json(await resourceAccessView(reader,parsed.data))
  }catch(error){
    if(error instanceof z.ZodError)return json({error:'validationGeneric'},400)
    if(error instanceof ActionFailureError)return json({error:error.code},error.code==='issueOutdated'?409:404)
    throw error
  }
}
export const GET=withRequestLog('/api/resources/[kind]/[id]/access',handle)
export const POST=withRequestLog('/api/resources/[kind]/[id]/access',handle)
