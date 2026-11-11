import { createEveApprovalBridge, requiresEveProductApproval, type ApprovalCall, type ApprovalPrincipal } from './approval-bridge'
import { eveApprovalStore } from './approval-store'
import type { NativeWriteReview } from '../operations/native-write-review'

/** Only called after gateway authorization, source lookup and tool validation.
 * These are the same product write implementations, with a pre-dispatch review
 * capability replacing their generic pending-action UI. */
async function run(call:ApprovalCall,review:NativeWriteReview):Promise<unknown> {
  if(call.name==='call_app_tool')return (await import('../app-tools-server')).runAppTools(call.ownerId,call.botId,'call',call.input,review)
  if(['send_email','create_calendar_event','update_calendar_event'].includes(call.name)) {
    const {COMPOSIO_ACTIONS}=await import('../composio-actions')
    const {botMayUseApp}=await import('../app-policy/store')
    const action=call.name as 'send_email'|'create_calendar_event'|'update_calendar_event'
    if(!await botMayUseApp(call.botId,COMPOSIO_ACTIONS[action].toolkit))return {error:'integrationBlockedByWorkspace'}
    const {account_id,...input}=call.input as Record<string,unknown>
    return (await import('../pending-action-store')).writeAccountAction(call.ownerId,action,input,typeof account_id==='string'?account_id:undefined,call.botId,undefined,review)
  }
  if(!call.executionId)throw new Error('agentExecutionClosed')
  try {
    return await (await import('../operations/write-runtime')).personalWriteFromRun(call.ownerId,call.botId,call.executionId,{action:call.name,input:call.input as Record<string,unknown>,toolCallId:call.callId},undefined,review)
  } catch(error) {
    // Review deliberately stops the existing transaction before a proposal is
    // stored. Other errors retain their original cause and fail the call.
    if(error instanceof Error&&error.message==='writeDenied')return {error:'writeDenied'}
    throw error
  }
}
async function bridge(call:ApprovalCall) {
  const {pool}=await import('../db')
  return createEveApprovalBridge({store:eveApprovalStore(pool,call.ownerId,call.botId),async run(c,review){
    const output=await run(c,review)
    const {maskDeep,credentialMasker}=await import('../secrets/mask')
    const safe=maskDeep(output,credentialMasker)
    await (await import('../credentials/chat-guard')).assertCredentialSafeChat(c.ownerId,safe)
    return safe
  }})
}
export async function reviewEveProductApproval(call:ApprovalCall) {
  if(!requiresEveProductApproval(call.name))return {status:'not-applicable' as const}
  return (await bridge(call)).review(call)
}
export async function executeEveApprovedWrite(call:ApprovalCall,responder?:ApprovalPrincipal):Promise<{output:unknown}|null> {
  if(!requiresEveProductApproval(call.name))return null
  return {output:await (await bridge(call)).execute(call,responder)}
}
