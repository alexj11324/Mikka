import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { withRequestLog } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { json,writeAllowed,forbiddenOrigin,unauthorized } from '@/lib/mobile-api'
import { threadExecutionGrantInput } from '@/lib/resource-access/input'
import { grantThreadExecution,revokeThreadExecution } from '@/lib/collaboration-run-authority'
import { threadExecutionView } from '@/lib/thread-execution-view'

export const dynamic='force-dynamic'
type Params={params:Promise<{id:string}>}
async function handle(request:Request,params:Params) {
  const session=await auth.api.getSession({headers:request.headers,query:{disableCookieCache:true}})
  if(!session)return unauthorized()
  if(request.method!=='GET'&&!writeAllowed(request))return forbiddenOrigin()
  const workspaceId=await effectiveRequestWorkspace(session.user)
  const id=z.uuid().safeParse((await params.params).id)
  if(!workspaceId||!id.success)return json({error:'runNotFound'},404)
  const reader={...session.user,[tokenWorkspace]:workspaceId,[enterprisePrincipal]:session.user[enterprisePrincipal]}
  try{
    if(request.method==='POST')await grantThreadExecution(reader,id.data,threadExecutionGrantInput.parse(await request.json().catch(()=>null)))
    if(request.method==='DELETE'){
      const input=z.object({grantId:z.uuid()}).strict().parse(await request.json().catch(()=>null))
      await revokeThreadExecution(reader,id.data,input.grantId)
    }
    return json(await threadExecutionView(reader,id.data))
  }catch(error){
    if(error instanceof z.ZodError)return json({error:'validationGeneric'},400)
    if(error instanceof ActionFailureError)return json({error:error.code},['runNotFound','workspaceAccessDenied','issueNotFound'].includes(error.code)?404:409)
    throw error
  }
}
export const GET=withRequestLog('/api/resources/thread/[id]/execution',handle)
export const POST=withRequestLog('/api/resources/thread/[id]/execution',handle)
export const DELETE=withRequestLog('/api/resources/thread/[id]/execution',handle)
