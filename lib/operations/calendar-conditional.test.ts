import assert from 'node:assert/strict'
import test from 'node:test'
import { composioConditionalCalendarDelete } from './calendar-conditional'
import type { ComposioActionClient } from '../composio-actions'

test('conditional calendar transport pins account and ETag and fences immediately before send', async () => {
 const calls:unknown[][]=[]; const signal=new AbortController().signal
 const client={ tools:{ proxyExecute:async (...args:unknown[])=>{calls.push(args);return {status:204}}} } as unknown as ComposioActionClient
 const send=composioConditionalCalendarDelete(client)!
 const input={ownerId:'owner',accountId:'account',eventId:'event/segment',ifMatch:'"etag"',sendUpdates:'all' as const,signal,beforeSend:async()=>{calls.push(['fence'])}}
 assert.deepEqual(await send(input),{status:204})
 assert.deepEqual(calls,[['fence'],[{endpoint:'/calendars/primary/events/event%2Fsegment',method:'DELETE',userId:'owner',connectedAccountId:'account',parameters:[{in:'header',name:'If-Match',value:'"etag"'},{in:'query',name:'sendUpdates',value:'all'}]},{signal}]])
 calls.length=0
 await assert.rejects(send({...input,beforeSend:async()=>{throw Error('revoked')}}),/revoked/)
 assert.deepEqual(calls,[])
 await assert.rejects(send({...input,ifMatch:'*'}),/integrationConditionalWriteUnavailable/)
 assert.deepEqual(calls,[])
})

test('Calendar provider uses conditional proxy transport and never sends after revoked fence',async()=>{
 const { composioWriteProvider }=await import('./write-provider')
 let writes=0, revoked=false
 const input={event_id:'fixture-event',send_updates:'none'}
 const event={id:input.event_id,etag:'"fixed"',status:'confirmed',eventType:'default'}
 const client={connectedAccounts:{list:async()=>({items:[{id:'account',toolkit:{slug:'googlecalendar'},status:'ACTIVE',isDisabled:false}]})},tools:{
  getRawComposioToolBySlug:async()=>({version:'pinned-v1'}),execute:async()=>({successful:true,data:event}),
  proxyExecute:async (params:{parameters:{name:string;value:string}[]})=>{assert.equal(params.parameters.find(p=>p.name==='If-Match')?.value,'"fixed"');writes++;return {status:204}},
 }} as unknown as ComposioActionClient
 const provider=composioWriteProvider(client,'cancel_calendar_event',composioConditionalCalendarDelete(client))
 const selected=await provider.prepare('owner',input)
 const args={ownerId:'owner',...selected,payload:input,approvalContext:selected.context??null,idempotencyKey:'stable',signal:new AbortController().signal,beforeSend:async()=>{if(revoked)throw Error('revoked')}}
 assert.equal((await provider.execute(args)).providerObjectId,input.event_id);assert.equal(writes,1)
 revoked=true;await assert.rejects(provider.execute(args),/revoked/);assert.equal(writes,1)
})
