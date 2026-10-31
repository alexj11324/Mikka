import { z } from 'zod'
import type { TeamSkillStore } from './team-skills'
import type { createSkillAssignments } from './assignments'
import { ImprovementError } from './contract'

const command=z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('register'),upload:z.unknown()}),
  z.strictObject({operation:z.enum(['approve','withdraw']),versionId:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}),
  z.strictObject({operation:z.literal('select'),versionId:z.uuid(),runId:z.uuid()}),
])
export function createTeamSkillHandler(dependencies:{
  store:Pick<TeamSkillStore,'register'|'read'|'review'|'list'>
  assignments:Pick<ReturnType<typeof createSkillAssignments>,'selectTeam'>
  principal(request:Request,workspaceId:string):Promise<string|null>
}) {
  return async(request:Request,workspaceId:string)=>{
    const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}})
    if(!z.uuid().safeParse(workspaceId).success)return reply({error:'invalid'},422)
    if(!['GET','POST'].includes(request.method))return reply({error:'methodNotAllowed'},405)
    if(request.method==='POST'&&request.headers.get('origin')!==new URL(request.url).origin)return reply({error:'originRejected'},403)
    const userId=await dependencies.principal(request,workspaceId)
    if(!userId)return reply({error:'authRequired'},401)
    const scope={workspaceId,userId}
    try {
      if(request.method==='GET') {
        const url=new URL(request.url),versionId=url.searchParams.get('versionId'),inspect=url.searchParams.get('inspect')==='1'
        if(!versionId)return reply(await dependencies.store.list(scope,inspect))
        if(!z.uuid().safeParse(versionId).success)return reply({error:'invalid'},422)
        return reply(await dependencies.store.read(scope,versionId,inspect))
      }
      const reader=request.body?.getReader()
      if(!reader)return reply({error:'invalid'},422)
      const chunks:Uint8Array[]=[];let bytes=0
      try {
        for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength
          if(bytes>128_000)return reply({error:'bodyTooLarge'},413);chunks.push(next.value)}
      } finally {await reader.cancel()}
      let input:unknown
      try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{return reply({error:'invalid'},422)}
      const parsed=command.safeParse(input)
      if(!parsed.success)return reply({error:'invalid'},422)
      const value=parsed.data
      if(value.operation==='register')return reply(await dependencies.store.register(scope,value.upload))
      if(value.operation==='select') {
        await dependencies.store.read(scope,value.versionId)
        return reply(await dependencies.assignments.selectTeam(userId,value.runId,value.versionId))
      }
      return reply(await dependencies.store.review(scope,{versionId:value.versionId,sha256:value.sha256},value.operation))
    } catch(error) {
      if(error instanceof ImprovementError)return reply({error:error.code},error.code==='notFound'?404:error.code==='invalid'?422:409)
      return reply({error:'teamSkillUnavailable'},503)
    }
  }
}
