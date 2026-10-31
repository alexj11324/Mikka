import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ComposioActionClient } from '../composio-actions'
import { composioWriteProvider, writeArguments } from './write-provider'
import { snapshotDigest } from './write-target'
import { WRITE_ACTIONS } from './write-contract'
// The write tools' tags as Composio returned them on 2026-10-31; prepare passes them to the destructive judgment.
const hints:Record<string,string[]>={NOTION_APPEND_BLOCK_CHILDREN:['openWorldHint'],SLACK_SEND_MESSAGE:['chat','important','openWorldHint'],GOOGLECALENDAR_DELETE_EVENT:['destructiveHint','idempotentHint','openWorldHint','important','Events Management']}
for (const action of WRITE_ACTIONS) test(action+' pins owner/account/target/version and rechecks before write',async()=>{
 const page=randomUUID(),input=action==='append_notion_paragraph'?{page_id:page,text:'One paragraph'}:action==='send_slack_message'?{channel:'C12345678',text:'<!channel> & literal'}:{event_id:'event-one',send_updates:'none'}
 const toolkit=action==='append_notion_paragraph'?'notion':action==='send_slack_message'?'slack':'googlecalendar'
 let writes=0, checks=0, revoked=false, wrongTarget=false
 const client={connectedAccounts:{list:async(args:{userIds:string[];toolkitSlugs:string[]})=>{assert.deepEqual(args.userIds,['owner']);assert.deepEqual(args.toolkitSlugs,[toolkit]);return {items:[{id:'bound',toolkit:{slug:toolkit},status:'ACTIVE',isDisabled:false}]}}},tools:{getRawComposioToolBySlug:async(slug:string)=>{assert.ok(['NOTION_APPEND_BLOCK_CHILDREN','NOTION_RETRIEVE_PAGE','SLACK_SEND_MESSAGE','SLACK_RETRIEVE_CONVERSATION_INFORMATION','GOOGLECALENDAR_DELETE_EVENT','GOOGLECALENDAR_EVENTS_GET'].includes(slug));return {version:'pinned-v1',tags:hints[slug]}},execute:async(slug:string,params:Record<string,unknown>,options?:{beforeExecute:(value:unknown)=>Promise<unknown>})=>{
 assert.equal(params.connectedAccountId,'bound');assert.equal(params.version,'pinned-v1')
 if(!options){assert.deepEqual(params.arguments,action==='send_slack_message'?{channel:input.channel}:action==='append_notion_paragraph'?{page_id:input.page_id}:{calendar_id:'primary',event_id:input.event_id});return {successful:true,data: action==='send_slack_message'?{channel:{id:wrongTarget?'C00000000':input.channel,is_member:true,is_archived:false,is_im:false,is_mpim:false,is_channel:true,is_group:false,is_private:false}}:{id:wrongTarget?(action==='cancel_calendar_event'?'eventone':'other'):(input.page_id??input.event_id),...(action==='cancel_calendar_event'?{etag:'"v1"',eventType:'default',status:'confirmed',organizer:{self:true,email:'synthetic@example.invalid'},start:{date:'2027-01-01'},end:{date:'2027-01-02'}}:{})}}}
 assert.deepEqual(params.arguments,writeArguments(action,input));await options.beforeExecute({params});writes++
 return {successful:true,data:action==='append_notion_paragraph'?{results:[{id:'new-block'}]}:action==='send_slack_message'?{channel:input.channel,ts:'1234567890.123456'}:{}}
 }}} as unknown as ComposioActionClient
 const provider=composioWriteProvider(client,action,async p=>{await p.beforeSend();assert.equal(p.ifMatch,'"v1"');writes++;return {status:204}},{version:'pinned-v1',metadataDigest:snapshotDigest({version:'pinned-v1'})}),selected=await provider.prepare('owner',input);assert.equal(writes,0)
 assert.deepEqual([selected.tool,selected.annotations],[{append_notion_paragraph:'NOTION_APPEND_BLOCK_CHILDREN',send_slack_message:'SLACK_SEND_MESSAGE',cancel_calendar_event:'GOOGLECALENDAR_DELETE_EVENT'}[action],hints[{append_notion_paragraph:'NOTION_APPEND_BLOCK_CHILDREN',send_slack_message:'SLACK_SEND_MESSAGE',cancel_calendar_event:'GOOGLECALENDAR_DELETE_EVENT'}[action]]])
 const args={ownerId:'owner',...selected,payload:input,approvalContext:selected.context??null,idempotencyKey:'stable',signal:new AbortController().signal,beforeSend:async()=>{checks++;if(revoked)throw Error('revoked')}}
 assert.ok((await provider.execute(args)).providerObjectId);assert.equal(checks,4);assert.equal(writes,1)
 revoked=true;await assert.rejects(provider.execute(args),/revoked/);assert.equal(writes,1)
 wrongTarget=true;await assert.rejects(provider.prepare('owner',input),/integrationTargetUnavailable/)
 assert.equal(await provider.lookup({ownerId:'owner',accountId:'bound',version:selected.version,payload:input,idempotencyKey:'stable'}),null)
 if(action==='send_slack_message')assert.equal(writeArguments(action,input).text,'<!channel> & literal')
})

import { channelSnapshot, calendarSnapshot } from './write-target'
const channel = { id:'G024BE91L',is_member:true,is_archived:false,is_im:false,is_mpim:false,is_channel:false,is_group:true,is_private:true }
const single = { id:'event-one',etag:'"v1"',eventType:'default',status:'confirmed',organizer:{self:true,email:'synthetic@example.invalid'},start:{date:'2027-01-01'},end:{date:'2027-01-02'},attendees:[{email:'guest@example.invalid'}] }
test('Slack snapshots preserve supported conversation facts without deciding their meaning',()=>{
 for(const patch of [{},{is_mpim:true},{is_im:true},{is_member:false},{is_archived:true},{is_private:false}]) assert.equal(channelSnapshot({...channel,...patch},channel.id).targetId,channel.id)
 assert.throws(()=>channelSnapshot({...channel,id:'different'},channel.id),/integrationTargetUnavailable/)
 assert.throws(()=>channelSnapshot({...channel,is_im:'invalid'},channel.id),/integrationTargetUnavailable/)
})
test('Calendar snapshots pin ID and ETag while retaining event facts',()=>{
 for(const patch of [{},{recurrence:['RRULE:FREQ=DAILY']},{recurringEventId:'master'},{eventType:'focusTime'},{organizer:{email:'other@example.invalid'}}]) assert.equal(calendarSnapshot({...single,...patch},'event-one','externalOnly').etag,'"v1"')
 for(const patch of [{etag:undefined},{etag:'*'},{id:'wrong'}]) assert.throws(()=>calendarSnapshot({...single,...patch},'event-one','none'),/integrationTargetUnavailable/)
})
test('native cancellation and Slack metadata read default closed without verified transports/contracts',async()=>{
 const client={connectedAccounts:{list:async()=>({items:[{id:'bound',toolkit:{slug:'slack'},status:'ACTIVE',isDisabled:false}]})},tools:{getRawComposioToolBySlug:async()=>({version:'fixed-v1'}),execute:async()=>{throw Error('read/write forbidden')}}} as unknown as ComposioActionClient
 await assert.rejects(composioWriteProvider(client,'send_slack_message').prepare('owner',{channel:channel.id,text:'Fixture'}),/integrationToolContractUnavailable/)
 for(const version of ['', 'latest', 'fixed-v1'])await assert.rejects(composioWriteProvider(client,'send_slack_message',undefined,{version,metadataDigest:'0'.repeat(64)}).prepare('owner',{channel:channel.id,text:'Fixture'}),/integrationToolContractUnavailable/)
})

test('Notion rechecks the approved target and owner connection at the SDK send boundary',async()=>{
 const page=randomUUID(),input={page_id:page,text:'Fixture'}
 let accountId='bound', archived=false, changeDuringPreflight: 'account' | 'target' | null=null, writes=0
 const client={connectedAccounts:{list:async({userIds}:{userIds:string[]})=>{
   assert.deepEqual(userIds,['owner'])
   return {items:[{id:accountId,toolkit:{slug:'notion'},status:'ACTIVE',isDisabled:false}]}
 }},tools:{getRawComposioToolBySlug:async()=>({version:'fixed-v1'}),execute:async(_slug:string,_params:unknown,options?:{beforeExecute:(value:unknown)=>Promise<unknown>})=>{
   if(!options)return {successful:true,data:{id:page,archived}}
   if(changeDuringPreflight==='account')accountId='replacement'
   if(changeDuringPreflight==='target')archived=true
   await options.beforeExecute({params:{}});writes++
   return {successful:true,data:{results:[{id:'synthetic-block'}]}}
 }}} as unknown as ComposioActionClient
 const provider=composioWriteProvider(client,'append_notion_paragraph'), selected=await provider.prepare('owner',input)
 const args={ownerId:'owner',...selected,payload:input,approvalContext:selected.context??null,idempotencyKey:'stable',signal:new AbortController().signal,beforeSend:async()=>{}}
 archived=true
 await assert.rejects(provider.execute(args),/integrationTargetUnavailable/)
 archived=false; changeDuringPreflight='target'
 await assert.rejects(provider.execute(args),/integrationTargetUnavailable/)
 archived=false; changeDuringPreflight='account'
 await assert.rejects(provider.execute(args),/integrationAccountUnavailable/)
 assert.equal(writes,0)
})
