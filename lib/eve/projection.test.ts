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
