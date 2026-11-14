import {eveChannel} from 'eve/channels/eve'
import type {RouteHandlerArgs} from 'eve/channels'
import {z} from 'zod'
import {internalEveRequestScope} from './auth'
import {assertEveScope,scopeAuth} from './scope'
import {bindEvaluationSession,loadEvaluationBinding} from './evaluation-store'

const prefix='/mikka/evaluations'
async function resolveEvaluation(request: Request) {
  const scope=internalEveRequestScope(request)
  const id=z.uuid().safeParse(request.headers.get('x-mikka-evaluation-id'))
  if(!scope||!id.success)return null
  await assertEveScope(scope)
  const {pool}=await import('../db')
  const binding=await loadEvaluationBinding(pool,scope,id.data,'route')
  if(!binding)return null
  return { scope, binding }
}

/** Standard Eve sessions, isolated from human chat, personal connections and
 * real product executors. Neither cookies nor clientContext can enable it. */
export function mikkaEvaluationChannel() {
  const base=eveChannel({audience:'private',turnPolicy:'queue',async auth(request) {
    const evaluation = await resolveEvaluation(request)
    if (!evaluation) return null
    const auth = scopeAuth(evaluation.scope)
    return { ...auth, attributes: { ...auth.attributes, evaluationBindingId: evaluation.binding.id } }
  }})
  return {...base,routes:base.routes.flatMap(route=>{
    if(route.transport==='websocket'||!route.path.startsWith('/eve/v1/session'))return []
    return [{...route,path:prefix+route.path,async handler(request:Request,args:RouteHandlerArgs) {
      const evaluation = await resolveEvaluation(request)
      if (!evaluation) return Response.json({ok:false,error:'authRequired'},{status:401})
      const { binding } = evaluation
      const sessionId=args.params.sessionId??args.params.parentSessionId
      if(sessionId&&sessionId!==binding.session_id)return Response.json({ok:false,error:'notFound'},{status:404})
      if(route.method==='POST'&&route.path==='/eve/v1/session'&&binding.session_id)return Response.json({ok:true,sessionId:binding.session_id})
      const response=await route.handler(request,args)
      if(response.ok&&route.method==='POST'&&route.path==='/eve/v1/session') {
        const result=await response.clone().json()
        const { pool } = await import('../db')
        await bindEvaluationSession(pool, binding.id, result.sessionId)
      }
      return response
    }}]
  })}
}
