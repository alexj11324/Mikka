import {eveChannel} from 'eve/channels/eve'
import type {RouteHandlerArgs} from 'eve/channels'
import type {EveAuthResult} from 'eve/channels/eve'
import {z} from 'zod'
import {internalEveScope} from './auth'
import {assertEveScope,scopeAuth,scopeFromAuth} from './scope'
import {bindEvaluationSession,loadEvaluationBinding} from './evaluation-store'
import {evaluationBindingId} from './evaluation-context'

const prefix='/mikka/evaluations'
async function authenticate(request:Request):Promise<EveAuthResult|null> {
  const scope=internalEveScope(request.headers.get('authorization'))
  const id=z.uuid().safeParse(request.headers.get('x-mikka-evaluation-id'))
  if(!scope||!id.success)return null
  await assertEveScope(scope)
  const {pool}=await import('../db')
  const binding=await loadEvaluationBinding(pool,scope,id.data)
  if(!binding)return null
  const auth=scopeAuth(scope)
  return {...auth,attributes:{...auth.attributes,evaluationBindingId:binding.id}}
}

/** Standard Eve sessions, isolated from human chat, personal connections and
 * real product executors. Neither cookies nor clientContext can enable it. */
export function mikkaEvaluationChannel() {
  const base=eveChannel({auth:authenticate,audience:'private',turnPolicy:'queue'})
  return {...base,routes:base.routes.flatMap(route=>{
    if(route.transport==='websocket'||!route.path.startsWith('/eve/v1/session'))return []
    return [{...route,path:prefix+route.path,async handler(request:Request,args:RouteHandlerArgs) {
      const auth=await authenticate(request)
      if(!auth)return Response.json({ok:false,error:'authRequired'},{status:401})
      const {pool}=await import('../db')
      const id=evaluationBindingId(auth)!
      const binding=(await loadEvaluationBinding(pool,scopeFromAuth(auth),id))!
      const sessionId=args.params.sessionId??args.params.parentSessionId
      if(sessionId&&sessionId!==binding.session_id)return Response.json({ok:false,error:'notFound'},{status:404})
      if(route.method==='POST'&&route.path==='/eve/v1/session'&&binding.session_id)return Response.json({ok:true,sessionId:binding.session_id})
      const response=await route.handler(request,args)
      if(response.ok&&route.method==='POST'&&route.path==='/eve/v1/session') {
        const result=await response.clone().json()
        await bindEvaluationSession(pool,id,result.sessionId)
      }
      return response
    }}]
  })}
}
