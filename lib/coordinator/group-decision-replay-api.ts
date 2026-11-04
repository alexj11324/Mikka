import type { Pool } from 'pg'
import { z } from 'zod'
import type { Directory } from '@/lib/group-conversations-store'
import { hostedBillingScope } from '@/lib/abuse/context'
import type { invokeDecision } from './decide'
import { GROUP_BASELINE_VERSION, GROUP_POLICY_VERSION, GROUP_V2_POLICY_VERSION } from './group-decision-policy'
import { GROUP_REPLAY_CASE_IDS, replayGroupDecision } from './group-decision-replay'
import { priceGroupDecisions } from './group-decision-trace'
import { groupDecisionTotals } from './group-decision-chain'

export const groupDecisionReplayInput = z.object({caseId:z.string().max(80).refine(value=>GROUP_REPLAY_CASE_IDS.includes(value)),policyVersion:z.enum([GROUP_BASELINE_VERSION,GROUP_V2_POLICY_VERSION,GROUP_POLICY_VERSION])}).strict()
export async function handleGroupDecisionReplay(pool:Pool,directory:Directory,req:{userId:string|null;conversationId:string;method:string;origin:string|null;host:string;body?:string;signal?:AbortSignal},invoke:typeof invokeDecision) {
  if (!req.userId) return {status:401,body:{error:'unauthorized'}}
  if (req.method!=='POST') return {status:405,body:{error:'method_not_allowed'}}
  if (!z.uuid().safeParse(req.conversationId).success) return {status:404,body:{error:'not_found'}}
  if (req.origin) {
    try {const url=new URL(req.origin);if(!['http:','https:'].includes(url.protocol)||url.host!==req.host)return{status:403,body:{error:'origin_rejected'}}}
    catch{return{status:403,body:{error:'origin_rejected'}}}
  }
  let raw:unknown
  try {if(!req.body || req.body.length>1000)throw Error();raw=JSON.parse(req.body)}catch{return{status:422,body:{error:'invalid_replay'}}}
  const parsed=groupDecisionReplayInput.safeParse(raw)
  if(!parsed.success)return{status:422,body:{error:'invalid_replay'}}
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    const finish=async(status:number,body:unknown)=>{await client.query(status<400?'COMMIT':'ROLLBACK');return{status,body}}
    // Same lock and workspace directory as normal group operations. No group
    // history, private bot configuration or credentials enter the test input.
    const {rows:[group]}=await client.query(`SELECT c."workspaceId" FROM conversations c JOIN conversation_members m ON m."conversationId"=c.id
      WHERE c.id=$1 AND c.kind='group' AND m."memberType"='user' AND m."memberId"=$2 AND m."leftAt" IS NULL FOR SHARE OF c`,[req.conversationId,req.userId])
    if(!group || !await directory(group.workspaceId,req.userId,[]))return finish(404,{error:'not_found'})
    const result=await hostedBillingScope.run({workspaceId:group.workspaceId,ownerId:req.userId},()=>replayGroupDecision(parsed.data.caseId,parsed.data.policyVersion,(purpose,input,questions,_signal,diagnostics)=>invoke(purpose,input,questions,req.signal,diagnostics)))
    result.decisions=await priceGroupDecisions(client,result.decisions)
    Object.assign(result,groupDecisionTotals(result.decisions))
    if(!await directory(group.workspaceId,req.userId,[]))return finish(404,{error:'not_found'})
    return finish(result.status==='unavailable'?503:200,result)
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}
