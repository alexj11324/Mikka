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

test('preparation refusals and safe references project without publishing hook diagnostics', () => {
  const reference = '11111111-1111-4111-8111-111111111111'
  const cases = [
    { error: { code: 'HOOK_FAILED', message: 'Hook "hooks/product.ts" failed: executionModelUnknown' }, expected: 'executionModelUnknown' },
    { error: { code: 'HOOK_FAILED', message: 'Hook "agent/hooks/product" failed: private diagnostic', id: reference, hint: 'private body' }, expected: `HOOK_FAILED · ref ${reference}` },
    { error: { code: 'MODEL_FAILED', message: 'private diagnostic', id: reference }, expected: `MODEL_FAILED · ref ${reference}` },
    { error: { code: 'reconnect_required', message: 'private diagnostic', id: reference }, expected: `reconnect_required · ref ${reference}` },
    { error: { code: 'HOOK_FAILED', message: 'Hook "agent/hooks/product" failed: cloudComputerUnavailable' }, expected: 'HOOK_FAILED' },
    { error: { code: 'HOOK_FAILED', message: 'Hook "agent/hooks/product" failed: executionModelUnknown private diagnostic' }, expected: 'HOOK_FAILED' },
    { error: { code: 'OTHER_FAILED', message: 'Hook "agent/hooks/product" failed: executionModelUnknown' }, expected: 'OTHER_FAILED' },
    { error: { code: 'HOOK_FAILED', message: 'private diagnostic', id: 'unsafe ref\n<script>' }, expected: 'HOOK_FAILED' },
    { error: { code: 'HOOK_FAILED', message: 'private diagnostic', id: 'unsafe\n' }, expected: 'HOOK_FAILED' },
    { error: { code: 'HOOK_FAILED', message: 'private diagnostic', id: '' }, expected: 'HOOK_FAILED' },
    { error: { code: 'HOOK_FAILED', message: 'private diagnostic', id: 'a'.repeat(129) }, expected: 'HOOK_FAILED' },
    { error: { code: 'HOOK_FAILED\n', message: 'private diagnostic' }, expected: 'turn_failed' },
    { error: { code: 'HOOK_FAILED', message: { private: 'diagnostic' }, id: { private: 'diagnostic' } }, expected: 'HOOK_FAILED' },
    { error: { code: 'unsafe code\nprivate diagnostic', message: 'private diagnostic', id: null }, expected: 'turn_failed' },
    { error: null, expected: 'turn_failed' },
    { error: undefined, expected: 'turn_failed' },
  ]
  for (const { error, expected } of cases) {
    const view = foldEvents(emptySessionView(), [
      { type: 'turn.started', data: { turnId: 'failed', cause: { deliveryId: 'request' }, follows: null } },
      { type: 'turn.settled', data: { turnId: 'failed', outcome: 'failed', error } },
    ].map((event, line) => ({ ...event, meta: { position: { line, index: 0 }, at: '2026-11-11T00:00:00Z', endOfLine: true } })) as ReceivedEvent[])
    const messages = projectEveTurn(view, 'wrun_fixture', 'failed', 'failed')
    assert.equal((messages[0] as { mikkaFailure?: string }).mikkaFailure, expected)
    assert.doesNotMatch(JSON.stringify(messages), /private|diagnostic|providerBody|Hook "|<script>/)
  }
})

test('a hook failure after a tool call never claims that no task started', () => {
  const view = foldEvents(emptySessionView(), [
    { type: 'turn.started', data: { turnId: 'failed', cause: { deliveryId: 'request' }, follows: null } },
    { type: 'call.requested', scope: { turnId: 'failed' }, data: { callId: 'dispatch', owner: { turnId: 'failed' }, capability: { kind: 'tool', name: 'dispatch_run' }, input: {} } },
    { type: 'turn.settled', data: { turnId: 'failed', outcome: 'failed', error: { code: 'HOOK_FAILED', message: 'Hook "agent/hooks/product" failed: executionModelUnknown' } } },
  ].map((event, line) => ({ ...event, meta: { position: { line, index: 0 }, at: '2026-11-11T00:00:00Z', endOfLine: true } })) as ReceivedEvent[])
  assert.equal((projectEveTurn(view, 'wrun_fixture', 'failed', 'failed')[0] as { mikkaFailure?: string }).mikkaFailure, 'HOOK_FAILED')
})

test('a cancelled turn keeps published interrupted text for display without importing it as model history', async () => {
  const { stoppedTurnDisplay } = await import('./projection')
  const sessionId = 'wrun_stop', turnId = 'turn_1'
  const records = [
    { type: 'content.completed', scope: { turnId: 'turn_0' }, data: { kind: 'text', value: 'Another turn', interrupted: true } },
    { type: 'content.completed', scope: { turnId }, data: { kind: 'text', value: 'Earlier words.' } },
    { type: 'content.delta', scope: { turnId }, data: { kind: 'text', delta: 'Partial words.' } },
    { type: 'content.completed', scope: { turnId }, data: { kind: 'reasoning', value: 'Private thought', interrupted: true } },
    { type: 'content.completed', scope: { turnId }, data: { kind: 'text', value: 'Partial words.', interrupted: true } },
    { type: 'turn.settled', data: {turnId, outcome:'cancelled'} },
    { type: 'turn.settled', data: {turnId:'before_first_token', outcome:'cancelled'} },
  ]
  const reader = { async *stream(options: { follow: boolean; startIndex: number }) {
    assert.equal(options.follow, false)
    assert.equal(options.startIndex, 7)
    yield* records
  } }
  const display = await stoppedTurnDisplay(reader as never, turnId, 7)
  const view = foldEvents(emptySessionView(), [
    {type:'turn.started',scope:{turnId},data:{turnId,cause:{deliveryId:'user'},follows:null}},
    {type:'call.requested',scope:{turnId},data:{callId:'call_1',owner:{turnId},capability:{kind:'tool',name:'list_issues'},input:{}}},
    {type:'call.settled',scope:{turnId},data:{callId:'call_1',outcome:'completed',output:[]}},
  ].map((event,line)=>({...event,meta:{position:{line,index:0},at:new Date(0).toISOString()}})))
  const messages = projectEveTurn(view, sessionId, turnId, 'cancelled', display)
  assert.ok(!JSON.stringify(messages[0].content).includes('Partial words.'))
  const [row] = chatItems(messages.map((message, i) => ({ position: i + 1, message, createdAt: new Date(0) })) as never)
  assert.deepEqual([row.text, row.stopped, row.streamId], ['Earlier words.\n\nPartial words.', true, 'eve:wrun_stop:turn_1'])
  assert.deepEqual(row.tools, ['list_issues'])
  assert.equal(row.activity?.tools[0].state, 'done')
  assert.equal(await stoppedTurnDisplay(reader as never, 'before_first_token', 7), undefined)
})

test('reading a stopped transcript retries incomplete history once and preserves Stop when the journal is unavailable', async t => {
  const { stoppedTurnDisplay } = await import('./projection')
  const part = {type:'content.completed', scope:{turnId:'turn_1'}, data:{kind:'text', value:'Already shown.', interrupted:true}}
  let attempts = 0
  const recovering = {async *stream() {
    yield part
    if (++attempts === 2) yield {type:'turn.settled', data:{turnId:'turn_1', outcome:'cancelled'}}
  }}
  assert.equal(await stoppedTurnDisplay(recovering as never, 'turn_1', 0), 'Already shown.')
  assert.equal(attempts,2)

  const warning = t.mock.method(console,'warn',()=>{})
  const unavailable = {async *stream() { yield part; throw new Error('private transport diagnostic') }}
  const display = await stoppedTurnDisplay(unavailable as never, 'turn_1', 0)
  const messages = projectEveTurn(emptySessionView(),'wrun_stop','turn_1','cancelled',display)
  assert.deepEqual(messages[0],{role:'assistant', content:[], mikkaStreamId:'eve:wrun_stop:turn_1', mikkaStopped:true})
  assert.deepEqual(warning.mock.calls.map(call=>call.arguments), [['eve_stopped_transcript_unavailable']])
})
