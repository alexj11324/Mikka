import { createHash } from 'node:crypto'
import type { NativeWriteDecision, NativeWriteReview } from '../operations/native-write-review'
import { isEveApprovalResponder, type ApprovalPrincipal } from './approval-principal'
export { isEveApprovalResponder, type ApprovalPrincipal } from './approval-principal'

export interface ApprovalCall {
  ownerId:string;botId:string;workspaceId:string;surface:'web'|'slack'
  sessionId:string;turnId:string;callId:string;executionId?:string|null;sourceEventId?:string|null
  name:string;input:unknown
}
export interface ApprovalRecord {
  callDigest:string;planDigest:string;decision:NativeWriteDecision
  status:'prepared'|'executing'|'done';output?:unknown
}
export interface ApprovalStore {
  read(key:string):Promise<ApprovalRecord|null>
  prepare(key:string,record:ApprovalRecord):Promise<ApprovalRecord>
  claim(key:string):Promise<boolean>
  finish(key:string,output:unknown):Promise<void>
}
const writes = new Set(['call_app_tool','send_email','create_calendar_event','update_calendar_event','append_notion_paragraph','send_slack_message','cancel_calendar_event'])
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]))
  return value
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const keyOf=(call:ApprovalCall)=>digest([call.ownerId,call.sessionId,call.turnId,call.callId])

/** The gateway authenticates the service and session/source before entering this
 * boundary. Review never grants a permission: only an exact native owner reply
 * can satisfy Ask, while every business gate still reads current authority. */
export function createEveApprovalBridge(deps:{store:ApprovalStore;run(call:ApprovalCall,review:NativeWriteReview):Promise<unknown>}) {
  function sameCall(record:ApprovalRecord,call:ApprovalCall) {
    if(record.callDigest!==digest(call))throw new Error('operationBindingConflict')
  }
  return {
    async review(call:ApprovalCall):Promise<{status:'not-applicable'|'denied'|'user-approval'}|null> {
      if(!writes.has(call.name))return null
      const key=keyOf(call), prior=await deps.store.read(key)
      if(prior) {sameCall(prior,call);return {status:prior.decision==='ask'?'user-approval':prior.decision==='deny'?'denied':'not-applicable'}}
      let decision:NativeWriteDecision='deny', planDigest=digest(['unavailable'])
      await deps.run(call,async(value,binding)=>{
        if(binding.ownerId!==call.ownerId||binding.botId!==call.botId)throw new Error('operationBindingConflict')
        decision=value;planDigest=digest([value,binding])
        return 'deny' // Stop before any proposal INSERT or provider dispatch.
      })
      const record=await deps.store.prepare(key,{callDigest:digest(call),planDigest,decision,status:'prepared'})
      sameCall(record,call)
      if(record.planDigest!==planDigest)throw new Error('writePolicyChanged')
      return {status:record.decision==='ask'?'user-approval':record.decision==='deny'?'denied':'not-applicable'}
    },
    async execute(call:ApprovalCall,responder?:ApprovalPrincipal):Promise<unknown> {
      if(!writes.has(call.name))throw new Error('integrationActionNotAllowed')
      const key=keyOf(call),record=await deps.store.read(key)
      if(!record)throw new Error('writeApprovalRequired')
      sameCall(record,call)
      if(record.decision==='deny')throw new Error('integrationActionDenied')
      if(record.decision==='ask'&&!isEveApprovalResponder(call,responder))throw new Error('writeApprovalRequired')
      if(record.status==='done')return record.output
      if(record.status==='executing'||!await deps.store.claim(key))return {error:'operationUncertain'}
      const output=await deps.run(call,async(decision,binding)=>{
        if(digest([decision,binding])!==record.planDigest)throw new Error('writePolicyChanged')
        if(decision==='deny')return 'deny'
        return decision==='ask'&&isEveApprovalResponder(call,responder)?'allow':decision
      })
      await deps.store.finish(key,output)
      return output
    },
  }
}

export const requiresEveProductApproval=(name:string)=>writes.has(name)
