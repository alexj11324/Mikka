import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEveApprovalBridge, type ApprovalCall, type ApprovalRecord } from './approval-bridge'

const call: ApprovalCall = { ownerId:'owner',botId:'bot',workspaceId:'workspace',surface:'web',sessionId:'session',turnId:'turn',callId:'call',name:'send_email',input:{to:['person@example.invalid'],body:'Final text'},sourceEventId:'event' }
const responder = {authenticator:'mikka',principalType:'user',principalId:'owner',attributes:{botId:'bot',workspaceId:'workspace',surface:'web'}}
function fixture(decision:'allow'|'ask'|'deny'='ask',early?:unknown) {
  const records = new Map<string,ApprovalRecord>()
  let sends = 0
  const audits:string[]=[]
  let version = '2026-11-11', uncertain = false
  const bridge = createEveApprovalBridge({
    beforeExecute:async()=>{audits.push('before')},
    afterExecute:async(_c,_output,failed)=>{audits.push(failed?'error':'after')},
    store: {
      async read(key) { return records.get(key) ?? null },
      async prepare(key,record) { const old=records.get(key); if(old) return old; records.set(key,record); return record },
      async claim(key) { const row=records.get(key)!; if(row.status!=='prepared') return false; row.status='executing'; return true },
      async finish(key,output) { Object.assign(records.get(key)!,{status:'done',output}) },
    },
    async run(_call,review) {
      if(early!==undefined)return early
      const result=await review(decision,{ownerId:call.ownerId,botId:call.botId,action:call.name,input:call.input,accountId:'account',version})
      if(result!=='allow') return {error:result==='deny'?'integrationActionDenied':'integrationApprovalRequired'}
      sends++
      if(uncertain)throw new Error('synthetic lost response')
      return {status:'done',actionId:'receipt'}
    },
  })
  return {bridge,records,audits,sends:()=>sends,setDecision:(value:typeof decision)=>{decision=value},setVersion:(value:string)=>{version=value},loseResponse:()=>{uncertain=true}}
}

test('Ask uses native approval without executing; an exact owner response sends once',async()=>{
  const f=fixture()
  assert.equal((await f.bridge.review(call))?.status,'user-approval')
  assert.equal(f.sends(),0)
  assert.deepEqual(f.audits,[])
  await assert.rejects(f.bridge.execute(call),/writeApprovalRequired/)
  const output=await f.bridge.execute(call,responder)
  assert.deepEqual(output,{status:'done',actionId:'receipt'})
  assert.deepEqual(await f.bridge.execute(call,responder),output)
  assert.equal(f.sends(),1)
  assert.deepEqual(f.audits,['before','after'])
})

test('Allow needs no native prompt and Deny never acquires an execution receipt',async()=>{
  const allowed=fixture('allow')
  assert.equal((await allowed.bridge.review(call))?.status,'not-applicable')
  assert.equal(allowed.sends(),0)
  await allowed.bridge.execute(call)
  assert.equal(allowed.sends(),1)
  const denied=fixture('deny')
  assert.equal((await denied.bridge.review(call))?.status,'denied')
  await assert.rejects(denied.bridge.execute(call,responder),/integrationActionDenied/)
  assert.equal(denied.sends(),0)
})

test('another principal, Bot, Workspace, surface or authenticator cannot approve',async()=>{
  const f=fixture();await f.bridge.review(call)
  for(const forged of [
    {...responder,principalId:'other'}, {...responder,principalType:'service'}, {...responder,authenticator:'slack'},
    {...responder,attributes:{...responder.attributes,botId:'other'}},
    {...responder,attributes:{...responder.attributes,workspaceId:'other'}},
    {...responder,attributes:{...responder.attributes,surface:'slack'}},
  ])await assert.rejects(f.bridge.execute(call,forged),/writeApprovalRequired/)
  assert.equal(f.sends(),0)
  await f.bridge.execute(call,responder)
  assert.equal(f.sends(),1)
})

test('approval is bound to exact tool, input, execution and source event',async()=>{
  const f=fixture();await f.bridge.review(call)
  for(const changed of [
    {...call,name:'create_calendar_event'}, {...call,input:{...call.input as object,body:'Changed'}},
    {...call,sourceEventId:'other'}, {...call,executionId:'other'},
  ])await assert.rejects(f.bridge.execute(changed,responder),/operationBindingConflict/)
  await assert.rejects(f.bridge.execute({...call,callId:'other'},responder),/writeApprovalRequired/)
  assert.equal(f.sends(),0)
})

test('changed resolved account version or current policy refuses dispatch',async()=>{
  for(const change of ['version','policy']) {
    const f=fixture();await f.bridge.review(call)
    if(change==='version')f.setVersion('changed');else f.setDecision('deny')
    await assert.rejects(f.bridge.execute(call,responder),/writePolicyChanged/)
    assert.equal(f.sends(),0)
  }
})

test('simultaneous native responses and an uncertain provider outcome never resend',async()=>{
  const f=fixture();await f.bridge.review(call)
  const result=await Promise.all([f.bridge.execute(call,responder),f.bridge.execute(call,responder)])
  assert.equal(f.sends(),1)
  assert.ok(result.some(output=>(output as {error?:string}).error==='operationUncertain'))
  const lost=fixture();await lost.bridge.review(call);lost.loseResponse()
  await assert.rejects(lost.bridge.execute(call,responder),/synthetic lost response/)
  assert.deepEqual(await lost.bridge.execute(call,responder),{error:'operationUncertain'})
  assert.equal(lost.sends(),1)
  assert.deepEqual(lost.audits,['before','error'])
})

test('an aborted native response cannot claim or dispatch the write',async()=>{
  const f=fixture();await f.bridge.review(call)
  await assert.rejects(f.bridge.execute(call,responder,AbortSignal.abort()))
  assert.equal(f.sends(),0);assert.deepEqual(f.audits,[])
  await f.bridge.execute(call,responder)
  assert.equal(f.sends(),1)
})

test('account selection and connection errors survive native preflight without a prompt or send',async()=>{
  for(const output of [{error:'integrationAccountSelectionRequired',accounts:[{id:'account-a',alias:'Work'},{id:'account-b',alias:'Personal'}]},{error:'integrationNotConnected'}]) {
    const f=fixture('ask',output)
    assert.equal((await f.bridge.review(call))?.status,'not-applicable')
    assert.deepEqual(await f.bridge.execute(call),output)
    assert.equal(f.sends(),0);assert.deepEqual(f.audits,[])
  }
})
