import type {Pool} from 'pg'
import {z} from 'zod'
import type {Directory} from './group-conversations-store'
import {pollGroupReviews,claimGroupReview,finishGroupReview,checkGroupReview} from './group-mailbox-runtime'
import {ReviewFailure} from './group-review-access'
const command=z.discriminatedUnion('action',[
  z.object({action:z.literal('poll')}).strict(),
  z.object({action:z.literal('claim'),runId:z.uuid()}).strict(),
  z.object({action:z.literal('check'),runId:z.uuid(),claimEpoch:z.number().int().positive()}).strict(),
  z.object({action:z.literal('complete'),runId:z.uuid(),reply:z.unknown()}).strict(),
])
export async function handleGroupWorkerRequest(request:Request,deviceId:string,deps:{pool:Pool;directory:Directory;authenticate:(request:Request)=>Promise<{userId:string}|null>}) {
  const caller=await deps.authenticate(request)
  const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}})
  if (!caller) return json({error:'unauthorized'},401)
  const parsed=command.safeParse(await request.json().catch(()=>null))
  if (!z.uuid().safeParse(deviceId).success || !parsed.success) return json({error:'invalid_input'},422)
  const input=parsed.data
  try {
    const result=input.action==='poll'?await pollGroupReviews(deps.pool,deps.directory,caller.userId,deviceId):input.action==='claim'?await claimGroupReview(deps.pool,deps.directory,caller.userId,deviceId,input.runId):input.action==='check'?await checkGroupReview(deps.pool,deps.directory,caller.userId,deviceId,input.runId,input.claimEpoch):await finishGroupReview(deps.pool,deps.directory,caller.userId,deviceId,input.runId,input.reply)
    return json(result)
  } catch(error) {if(error instanceof ReviewFailure)return json({error:error.code},error.status);throw error}
}
