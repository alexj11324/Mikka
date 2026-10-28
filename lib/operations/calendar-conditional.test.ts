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
