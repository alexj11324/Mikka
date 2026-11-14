import assert from 'node:assert/strict'
import test from 'node:test'
import {emptySessionView,foldEvents,type ReceivedEvent} from 'eve/events'
import {chatItems} from '../coordinator/context'
import {projectEveTurn} from './projection'

test('completed native calls retain results and dispatched thread cards after history projection',()=>{
  const turnId='turn_0',sessionId='wrun_fixture',runId='10000000-0000-4000-8000-000000000001'
  const facts=[
    {type:'turn.started',data:{turnId,cause:{deliveryId:'delivery_0'},follows:null}},
    {type:'call.requested',data:{callId:'call_1',owner:{turnId},capability:{kind:'tool',name:'dispatch_run'},input:{issueId:'10000000-0000-4000-8000-000000000002'}}},
    {type:'call.started',data:{callId:'call_1'}},
    {type:'call.settled',data:{callId:'call_1',outcome:'completed',output:{runId}}},
    {type:'content.completed',data:{partId:'part_1',kind:'text',phase:'reply',value:'The task has started.'}},
    {type:'turn.settled',data:{turnId,outcome:'completed',reply:['part_1']}},
  ]
  const events:ReceivedEvent[]=facts.map((event,line)=>({...event,scope:{turnId},meta:{position:{line,index:0},at:'2026-11-11T00:00:00.000Z',endOfLine:true}}))
  const view=foldEvents(emptySessionView(),events)
  const messages=projectEveTurn(view,sessionId,turnId,'completed')
  const history=chatItems(messages.map((message,position)=>({message,position:position+1,createdAt:new Date('2026-11-11T00:00:00Z')})) as never)
  assert.equal(history.length,1)
  assert.equal(history[0].text,'The task has started.')
  assert.equal(history[0].streamId,`eve:${sessionId}:${turnId}`)
  assert.deepEqual(history[0].threads,[runId])
  assert.equal(history[0].activity?.tools[0].state,'done')
  assert.match(history[0].activity?.tools[0].output ?? '',new RegExp(runId))
})

test('turn projection lists its native tools once across a long session',async t=>{
  const eve = await import('eve/events')
  let listed = 0, observed = 0
  t.mock.module('eve/events',{namedExports:{...eve,calls:(...args:Parameters<typeof eve.calls>)=>{
    listed++
    const result = eve.calls(...args)
    observed += result.length
    return result
  }}})
  const {projectEveTurn:project}:typeof import('./projection') = await import(new URL('./projection.ts?profile=turn-calls',import.meta.url).href)
  const facts = []
  for (const turnId of ['previous','current']) {
    facts.push({type:'turn.started',data:{turnId,cause:{deliveryId:'delivery_'+turnId},follows:null}})
    for(let i=0;i<64;i++) {
      const callId = turnId+'_'+i
      facts.push({type:'call.requested',scope:{turnId},data:{callId,owner:{turnId},capability:{kind:'tool',name:'list_issues'},input:{page:i}}})
      if (i<63) facts.push({type:'call.settled',scope:{turnId},data:{callId,outcome:'completed',output:i}})
    }
  }
  const view = foldEvents(emptySessionView(),facts.map((fact,line)=>({...fact,meta:{position:{line,index:0},at:'2026-11-11T00:00:00Z',endOfLine:true}})) as ReceivedEvent[])
  const result = project(view,'wrun_fixture','current','completed')
  const requested = Array.from({length:64},(_,i)=>({type:'tool-call',toolCallId:'current_'+i,toolName:'list_issues',input:{page:i}}))
  const completed = Array.from({length:63},(_,i)=>({type:'tool-result',toolCallId:'current_'+i,toolName:'list_issues',output:{type:'json',value:i}}))
  assert.deepEqual(result[0].content,requested)
  assert.deepEqual(result[1].content,completed)
  t.diagnostic(`Eve calls queries: ${listed}, matching call observations returned: ${observed}`)
  assert.equal(listed,1)
})

test('native failed outcomes preserve a closed provider code without publishing raw errors',()=>{
  const view=foldEvents(emptySessionView(),[
    {type:'turn.started',data:{turnId:'turn_failed',cause:{deliveryId:'delivery_failed'},follows:null},meta:{position:{line:0,index:0},at:'2026-11-11T00:00:00Z',endOfLine:true}},
    {type:'turn.settled',data:{turnId:'turn_failed',outcome:'failed',error:{code:'rate_limit_exceeded',message:'Private provider diagnostic'}},meta:{position:{line:1,index:0},at:'2026-11-11T00:00:01Z',endOfLine:true}},
  ])
  const messages=projectEveTurn(view,'wrun_fixture','turn_failed','failed')
  assert.ok('mikkaFailure' in messages[0])
  assert.equal(messages[0].mikkaFailure,'rate_limit_exceeded')
  assert.equal(JSON.stringify(messages).includes('Private provider diagnostic'),false)
})
