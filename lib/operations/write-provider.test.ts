import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ComposioActionClient } from '../composio-actions'
import { composioWriteProvider, writeArguments } from './write-provider'
import { WRITE_ACTIONS } from './write-contract'
for (const action of WRITE_ACTIONS) test(action+' pins owner/account/target/version and rechecks before write',async()=>{
 const page=randomUUID(),input=action==='append_notion_paragraph'?{page_id:page,text:'One paragraph'}:action==='send_slack_message'?{channel:'C12345678',text:'<!channel> & literal'}:{event_id:'event-one',send_updates:'none'}
 const toolkit=action==='append_notion_paragraph'?'notion':action==='send_slack_message'?'slack':'googlecalendar'
 let writes=0, checks=0, revoked=false, wrongTarget=false
 const client={connectedAccounts:{list:async(args:{userIds:string[];toolkitSlugs:string[]})=>{assert.deepEqual(args.userIds,['owner']);assert.deepEqual(args.toolkitSlugs,[toolkit]);return {items:[{id:'bound',toolkit:{slug:toolkit},status:'ACTIVE',isDisabled:false}]}}},tools:{getRawComposioToolBySlug:async()=>({version:'pinned-v1'}),execute:async(slug:string,params:Record<string,unknown>,options?:{beforeExecute:(value:unknown)=>Promise<unknown>})=>{
 assert.equal(params.connectedAccountId,'bound');assert.equal(params.version,'pinned-v1')
 if(!options)return {successful:true,data: action==='send_slack_message'?{channel:{id:wrongTarget?'C00000000':input.channel,is_member:true,is_archived:false}}:{id:wrongTarget?(action==='cancel_calendar_event'?'eventone':'other'):(input.page_id??input.event_id)}}
 assert.deepEqual(params.arguments,writeArguments(action,input));await options.beforeExecute({params});writes++
 return {successful:true,data:action==='append_notion_paragraph'?{results:[{id:'new-block'}]}:action==='send_slack_message'?{channel:input.channel,ts:'1234567890.123456'}:{}}
 }}} as unknown as ComposioActionClient
 const provider=composioWriteProvider(client,action),selected=await provider.prepare('owner',input);assert.equal(writes,0)
 const args={ownerId:'owner',...selected,payload:input,idempotencyKey:'stable',signal:new AbortController().signal,beforeSend:async()=>{checks++;if(revoked)throw Error('revoked')}}
 assert.ok((await provider.execute(args)).providerObjectId);assert.equal(checks,2);assert.equal(writes,1)
 revoked=true;await assert.rejects(provider.execute(args),/revoked/);assert.equal(writes,1)
 wrongTarget=true;await assert.rejects(provider.prepare('owner',input),/integrationTargetUnavailable/)
 assert.equal(await provider.lookup({ownerId:'owner',accountId:'bound',idempotencyKey:'stable'}),null)
 if(action==='send_slack_message')assert.equal(writeArguments(action,input).text,'&lt;!channel&gt; &amp; literal')
})
