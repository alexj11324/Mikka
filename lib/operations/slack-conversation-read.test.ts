import assert from 'node:assert/strict'
import test from 'node:test'
import type { ComposioActionClient } from '../composio-actions'
import { composioSlackConversationReader, SLACK_CONVERSATION_READ_CONTRACT } from './slack-conversation-read'
import { composioWriteProvider } from './write-provider'

test('Slack adapter fixes the documented endpoint and account; malformed and foreign responses fail closed',async()=>{
 let response:unknown={status:200,data:{ok:true,channel:{id:'D12345678',is_im:true,user:'U12345678'}}}
 const calls:unknown[]=[]
 const client={tools:{proxyExecute:async (input:unknown)=>{calls.push(input);return response}}} as unknown as ComposioActionClient
 const reader=composioSlackConversationReader(client)!
 assert.equal((await reader('owner','account','D12345678')).is_im,true)
 assert.deepEqual(calls,[{endpoint:'/conversations.info',method:'GET',userId:'owner',connectedAccountId:'account',parameters:[{in:'query',name:'channel',value:'D12345678'}]}])
 for(const bad of [{status:403,data:{ok:true,channel:{id:'D12345678'}}},{status:200,data:{ok:false}},{status:200,data:{ok:true,channel:{id:'D87654321'}}}]) {
  response=bad;await assert.rejects(reader('owner','account','D12345678'),/integrationTargetUnavailable/)
 }
})

test('provider binds local Slack read contract and lets model-selected direct conversation pass',async()=>{
 const client={connectedAccounts:{list:async()=>({items:[{id:'account',toolkit:{slug:'slack'},status:'ACTIVE',isDisabled:false}]})},tools:{getRawComposioToolBySlug:async()=>({version:'write-v1'}),proxyExecute:async()=>({status:200,data:{ok:true,channel:{id:'D12345678',is_im:true,user:'U12345678'}}})}} as unknown as ComposioActionClient
 const provider=composioWriteProvider(client,'send_slack_message',undefined,undefined,composioSlackConversationReader(client))
 const selected=await provider.prepare('owner',{channel:'D12345678',text:'hello'})
 assert.equal(selected.accountId,'account');assert.equal(selected.version,'write-v1')
 assert.equal(selected.context?.readContract,SLACK_CONVERSATION_READ_CONTRACT)
 assert.equal(selected.context?.is_im,true)
})

test('Slack provider executes the selected text once and rejects changed target before sending',async()=>{
 let name='original', sent=0, fence=0
 const channel='D12345678',input={channel,text:'<!channel> & literal'}
 const client={connectedAccounts:{list:async()=>({items:[{id:'account',toolkit:{slug:'slack'},status:'ACTIVE',isDisabled:false}]})},tools:{
  getRawComposioToolBySlug:async()=>({version:'write-v1'}),
  proxyExecute:async()=>({status:200,data:{ok:true,channel:{id:channel,is_im:true,user:'U12345678',name}}}),
  execute:async (_name:string,params:{arguments:unknown},options:{beforeExecute:(value:unknown)=>Promise<unknown>})=>{assert.deepEqual(params.arguments,{channel,text:input.text});await options.beforeExecute({params});sent++;return {successful:true,data:{channel,ts:'123.456'}}},
 }} as unknown as ComposioActionClient
 const provider=composioWriteProvider(client,'send_slack_message',undefined,undefined,composioSlackConversationReader(client))
 const selected=await provider.prepare('owner',input)
 const args={ownerId:'owner',...selected,payload:input,approvalContext:selected.context??null,idempotencyKey:'stable',signal:new AbortController().signal,beforeSend:async()=>{fence++}}
 assert.equal((await provider.execute(args)).providerObjectId,'123.456');assert.equal(sent,1);assert.ok(fence>0)
 name='changed';await assert.rejects(provider.execute(args),/operationTargetChanged/);assert.equal(sent,1)
})
