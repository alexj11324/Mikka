import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { WorkflowAgent } from '@ai-sdk/workflow'
import { APICallError, streamText, jsonSchema, isStepCount, type LanguageModel, type ToolSet, type ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { SubscriptionWorkflowModel } from './subscription-workflow-model'
import { invalidToolParts } from './coordinator/invalid-tool-call'
import type { ModelCallStreamPart } from '@ai-sdk/workflow'
import { runHostedWorkflowTurn } from './subscription-workflow-turn'
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const runtime={harness:'ai_sdk',actorId:'alice',model:'saved-model',modelSelection:{type:'subscription' as const,bindingId:id(3),ownerId:'alice',actorId:'alice',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'saved-model',route:'claude_cpa' as const}}
test('hosted subscription uses Workflow streaming, zero retry and returns tool-loop messages',async t=>{
  let calls=0
  const writable=new WritableStream<ModelCallStreamPart>()
  t.mock.method(WorkflowAgent.prototype,'generate',()=>{throw new Error('paid fallback')})
  t.mock.method(WorkflowAgent.prototype,'stream',async (options: {maxRetries:number;writable:unknown;preventClose:boolean})=>{
    calls++;assert.equal(options.maxRetries,0);assert.equal(options.writable,writable);assert.equal(options.preventClose,true)
    return {steps:[{text:'working',response:{messages:[{role:'assistant',content:'tool call'},{role:'tool',content:'tool result'}]}},{text:'done',response:{messages:[{role:'assistant',content:'done'}]}}],finishReason:'stop'}
  })
  const result=await runHostedWorkflowTurn(runtime,{}, {prompt:'synthetic',maxRetries:9,writable,preventClose:true})
  assert.equal(calls,1);assert.equal(result.text,'done')
  assert.deepEqual(result.responseMessages,[{role:'assistant',content:'tool call'},{role:'tool',content:'tool result'},{role:'assistant',content:'done'}])
})
test('stream refusal does not invoke generate or retry',async t=>{
  let calls=0
  t.mock.method(WorkflowAgent.prototype,'generate',()=>{throw new Error('paid fallback')})
  t.mock.method(WorkflowAgent.prototype,'stream',async ()=>{calls++;throw new Error('synthetic refusal')})
  await assert.rejects(runHostedWorkflowTurn(runtime,{}, {prompt:'synthetic'}),/synthetic refusal/)
  assert.equal(calls,1)
})
test('a Workflow stream error logs bounded diagnostics and keeps one attempt and a generic refusal', async t => {
  const logs: string[] = []
  let calls = 0
  t.mock.method(console, 'warn', (line: string) => logs.push(line))
  t.mock.method(WorkflowAgent.prototype, 'generate', () => { throw new Error('paid fallback') })
  const error = new APICallError({ message: 'fixture-private-message', url: 'https://fixture.invalid/private', requestBodyValues: { secret: 'fixture-private-input' }, responseBody: 'fixture-private-response', statusCode: 429, cause: Object.assign(new Error('fixture-private-cause'), { code: 'ETIMEDOUT' }) })
  t.mock.method(WorkflowAgent.prototype, 'stream', async (options: { maxRetries: number }) => {
    calls++; assert.equal(options.maxRetries, 0)
    return { error }
  })
  await assert.rejects(runHostedWorkflowTurn(runtime, {}, { prompt: 'synthetic', maxRetries: 9 }), { message: 'subscription_generation_failed' })
  assert.equal(calls, 1)
  assert.equal(logs.length, 1)
  const diagnostic = JSON.parse(logs[0])
  assert.equal(diagnostic.stage, 'workflow_result')
  assert.equal(diagnostic.errorClass, 'AI_APICallError')
  assert.equal(diagnostic.statusCode, 429)
  assert.deepEqual(diagnostic.causes, [{ errorClass: 'Error', errorCode: 'ETIMEDOUT', statusCode: null }])
  assert.ok(!logs.join('\n').includes('fixture-private'))
})
test('a fixed refusal code in the cause chain becomes the detail, never the provider text', async t => {
  t.mock.method(console, 'warn', () => {})
  const rejected = Object.assign(new Error('codex response 400 invalid_request_error fixture-private'), { code: 'provider_request_rejected' })
  const error = new APICallError({ message: 'fixture-private-message', url: 'https://fixture.invalid/private', requestBodyValues: {}, statusCode: 400, cause: rejected })
  t.mock.method(WorkflowAgent.prototype, 'stream', async () => ({ error }))
  await assert.rejects(runHostedWorkflowTurn(runtime, {}, { prompt: 'synthetic' }), (thrown: Error) => {
    assert.equal(thrown.message, 'subscription_generation_failed (provider_request_rejected)')
    assert.ok(!thrown.message.includes('fixture-private'))
    return true
  })
})
test('an undefined stream error or failed logger cannot turn a refusal into success or retry', async t => {
  let calls = 0, logAttempts = 0
  t.mock.method(console, 'warn', () => { logAttempts++; throw new Error('logger unavailable') })
  t.mock.method(WorkflowAgent.prototype, 'generate', () => { throw new Error('paid fallback') })
  t.mock.method(WorkflowAgent.prototype, 'stream', async (options: { maxRetries: number }) => {
    calls++; assert.equal(options.maxRetries, 0)
    return { error: undefined }
  })
  await assert.rejects(runHostedWorkflowTurn(runtime, {}, { prompt: 'synthetic' }), { message: 'subscription_generation_failed' })
  assert.equal(calls, 1)
  assert.equal(logAttempts, 1)
})
test('default snapshot streams with zero retry and malformed subscription never falls back',async t=>{
  let streamed=0
  const writable=new WritableStream<ModelCallStreamPart>()
  t.mock.method(WorkflowAgent.prototype,'generate',()=>{throw new Error('unexpected generate')})
  t.mock.method(WorkflowAgent.prototype,'stream',async (options:{maxRetries:number;writable:unknown;preventClose:boolean})=>{
    streamed++;assert.equal(options.maxRetries,0);assert.equal(options.writable,writable);assert.equal(options.preventClose,true)
    return {steps:[{text:'default',response:{messages:[]}}],finishReason:'stop'}
  })
  const result=await runHostedWorkflowTurn({harness:'ai_sdk',actorId:'alice',model:'saved-default'}, {}, {prompt:'synthetic',writable,preventClose:true}, {ownerId:'alice',actorId:'alice',botId:null})
  assert.equal(result.text,'default');assert.equal(streamed,1)
  await assert.rejects(runHostedWorkflowTurn({...runtime,model:'different'}, {}, {prompt:'synthetic'}),/subscription_model_unavailable/)
  await assert.rejects(runHostedWorkflowTurn({harness:'ai_sdk',actorId:'alice',model:'saved-default'}, {}, {prompt:'synthetic'}),/verification_required/)
  assert.equal(streamed,1)
})
test('malformed explicit frozen selection never invokes the default model',async t=>{
  let generated=0
  t.mock.method(WorkflowAgent.prototype,'generate',async ()=>{generated++;return {text:'default',responseMessages:[],finishReason:'stop'}})
  t.mock.method(WorkflowAgent.prototype,'stream',()=>{throw new Error('unexpected stream')})
  for(const modelSelection of [null,false,0,'']) {
    const invalid={...runtime,modelSelection} as unknown as Parameters<typeof runHostedWorkflowTurn>[0]
    await assert.rejects(runHostedWorkflowTurn(invalid,{}, {prompt:'synthetic'}))
  }
  assert.equal(generated,0)
})

test('after 停止 a tool call that has not started does not run; one already running finishes and is timed', async () => {
  const { timedTools, STOPPED_TOOL_RESULT } = await import('./subscription-workflow-turn')
  const ran: string[] = []
  const stop = new AbortController()
  const timings: { tool: string; ms: number; failed: boolean }[] = []
  const tools = timedTools({
    dispatch_run: { inputSchema: {} as never, execute: async () => { ran.push('dispatch_run'); stop.abort(); return { status: 'queued' } } },
    create_issue: { inputSchema: {} as never, execute: async () => { ran.push('create_issue'); return { id: 'i' } } },
  } as never, timings, () => 0, stop.signal) as unknown as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>
  // Running when 停止 came: it finishes.
  assert.deepEqual(await tools.dispatch_run.execute({}, {}), { status: 'queued' })
  // Next in line after 停止: never runs.
  assert.deepEqual(await tools.create_issue.execute({}, {}), STOPPED_TOOL_RESULT)
  assert.deepEqual(ran, ['dispatch_run'])
  assert.deepEqual(timings.map(timing => timing.tool), ['dispatch_run'])
})

test('停止 while the before-tool audit waits prevents the tool body and closes its audit as stopped', async () => {
  const { timedTools } = await import('./subscription-workflow-turn')
  const { instrumentTools } = await import('./agent-kit/instrument')
  const stop = new AbortController()
  const events: string[] = []
  let bodyCalls = 0, release!: () => void, entered!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const begun = new Promise<void>(resolve => { entered = resolve })
  const instrumented = instrumentTools({ web_search: { inputSchema: {} as never, execute: async () => { bodyCalls++; return { found: true } } } }, ['web_search'], {
    before: async () => { events.push('start'); entered(); await pending },
    after: async (_call, _name, outcome) => { events.push(outcome) },
  })
  const tools = timedTools(instrumented, [], () => 0, stop.signal)
  // WorkflowAgent passes its effective abort signal through the execute context.
  const context = { toolCallId: 'call-stopped', messages: [], abortSignal: stop.signal }
  const execute = tools.web_search.execute as unknown as (input: unknown, options: typeof context) => Promise<unknown>
  const run = execute({}, context)
  await begun
  stop.abort(); release()
  assert.deepEqual(await run, { error: 'stopped' })
  assert.equal(bodyCalls, 0)
  assert.deepEqual(events, ['start', 'stopped'])
})

const usage={inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}

/** Actual installed SDK parser and loop with our constructed model/tools;
 * only durable scheduling is stubbed. All inference is an in-memory fixture. */
function sdkWorkflow(t: TestContext, observe?: (messages:ModelMessage[])=>void) {
  t.mock.method(WorkflowAgent.prototype,'stream',async function(this:unknown, options:Record<string,unknown>){
    const agent=this as {model:LanguageModel;tools:ToolSet}
    const result=streamText({...options,model:agent.model,tools:agent.tools} as Parameters<typeof streamText>[0])
    await result.consumeStream()
    const steps=await result.steps
    observe?.(steps.flatMap(step=>step.response.messages))
    return {steps,finishReason:await result.finishReason}
  })
}

for(const toolName of ['none','unregistered','']) test(`actual SDK repairs ${JSON.stringify(toolName)} once without executing a tool or leaking its error`,async t=>{
  let modelCalls=0,executed=0
  const logs:string[]=[]
  let sdkMessages:ModelMessage[]=[]
  t.mock.method(console,'warn',(line:string)=>logs.push(line))
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('No external model call in this regression')})
  sdkWorkflow(t,messages=>{sdkMessages=messages})
  t.mock.method(SubscriptionWorkflowModel.prototype,'doStream',async()=>({stream:new ReadableStream({start(controller){
    modelCalls++
    controller.enqueue({type:'stream-start',warnings:[]})
    if(modelCalls===1) controller.enqueue({type:'tool-call',toolCallId:'invalid',toolName,input:'{"x":"private model input"}'})
    else{
      controller.enqueue({type:'text-start',id:'text'})
      controller.enqueue({type:'text-delta',id:'text',delta:'Corrected reply'})
      controller.enqueue({type:'text-end',id:'text'})
    }
    controller.enqueue({type:'finish',finishReason:{unified:modelCalls===1?'tool-calls':'stop',raw:modelCalls===1?'tool_calls':'stop'},usage})
    controller.close()
  }})}))
  const result=await runHostedWorkflowTurn(runtime,{registered:{inputSchema:jsonSchema({type:'object',properties:{}}),execute:async()=>{executed++;return{ok:true}}}}, {prompt:'Synthetic request',stopWhen:isStepCount(120)})
  assert.equal(result.text,'Corrected reply');assert.equal(modelCalls,2);assert.equal(executed,0)
  const rawCall=sdkMessages.flatMap(message=>message.role==='assistant'&&Array.isArray(message.content)?message.content:[]).find(part=>part.type==='tool-call')
  assert.equal((rawCall as {invalid?:boolean}).invalid,undefined,'SDK drops invalid:true in response.messages')
  assert.equal(invalidToolParts(sdkMessages).size,2,'legacy response messages still identify the paired invalid call')
  assert.equal(invalidToolParts(result.responseMessages).size,2,'host marker survives persistence projection')
  const diagnostic=JSON.parse(logs.find(line=>line.includes('model_invalid_tool_call'))!)
  assert.equal(diagnostic.invalidSteps,1);assert.equal(diagnostic.recoverySteps,1);assert.equal(diagnostic.exhausted,false)
  assert.equal(diagnostic.counts[toolName==='none'?'none':toolName===''?'empty':'unknown'],1)
  assert.doesNotMatch(logs.join('\n'),/private model input|unregistered|NoSuchTool/)
})

test('two invalid SDK steps stop even with text, without a third model request or a false success',async t=>{
  let calls=0
  t.mock.method(console,'warn',()=>{})
  sdkWorkflow(t)
  t.mock.method(SubscriptionWorkflowModel.prototype,'doStream',async()=>({stream:new ReadableStream({start(controller){
    calls++
    assert.ok(calls<=2,'the invalid-tool budget must stop this loop')
    controller.enqueue({type:'stream-start',warnings:[]})
    controller.enqueue({type:'text-start',id:'text'})
    controller.enqueue({type:'text-delta',id:'text',delta:'Unfinished partial text'})
    controller.enqueue({type:'text-end',id:'text'})
    controller.enqueue({type:'tool-call',toolCallId:'invalid-'+calls,toolName:'none',input:'{}'})
    controller.enqueue({type:'finish',finishReason:{unified:'tool-calls',raw:'tool_calls'},usage})
    controller.close()
  }})}))
  await assert.rejects(runHostedWorkflowTurn(runtime,{}, {prompt:'Synthetic request',stopWhen:isStepCount(120)}),{code:'model_tool_unavailable'})
  assert.equal(calls,2)
})

test('completed legitimate tool receipts survive exhausted SDK recovery without replaying the tool',async t=>{
  let modelCalls=0,executed=0
  const completed:ModelMessage[]=[]
  t.mock.method(console,'warn',()=>{})
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('No external model call in this regression')})
  sdkWorkflow(t)
  t.mock.method(SubscriptionWorkflowModel.prototype,'doStream',async()=>({stream:new ReadableStream({start(controller){
    modelCalls++
    assert.ok(modelCalls<=3,'one completed tool step and two invalid steps exhaust the turn')
    controller.enqueue({type:'stream-start',warnings:[]})
    controller.enqueue({type:'tool-call',toolCallId:'call-'+modelCalls,toolName:modelCalls===1?'registered':'none',input:'{}'})
    controller.enqueue({type:'finish',finishReason:{unified:'tool-calls',raw:'tool_calls'},usage})
    controller.close()
  }})}))
  await assert.rejects(runHostedWorkflowTurn(runtime,{
    registered:{inputSchema:jsonSchema({type:'object',properties:{}}),execute:async()=>{executed++;return{receipt:'completed-once'}}},
  },{prompt:'Synthetic request',stopWhen:isStepCount(120),onStepEnd:step=>{completed.push(...step.response.messages)}}),{code:'model_tool_unavailable'})
  assert.equal(modelCalls,3);assert.equal(executed,1)
  const calls=completed.filter(message=>message.role==='assistant').flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='tool-call')
  const receipts=completed.filter(message=>message.role==='tool').flatMap(message=>message.content).filter(part=>part.type==='tool-result')
  assert.equal(calls.length,3);assert.equal(receipts.length,3)
  assert.equal(calls.filter(call=>call.toolName==='registered').length,1)
  assert.deepEqual(receipts.find(receipt=>receipt.toolName==='registered')?.output,{type:'json',value:{receipt:'completed-once'}})
  assert.equal(invalidToolParts(completed).size,4,'both original invalid call/result pairs remain available to the failure step')
  assert.match(JSON.stringify(completed),/AI_NoSuchToolError/,'raw evidence remains available for server diagnostics')
})

test('actual OpenAI-compatible serialization sends no welcome tools and retains normal-turn tools',async t=>{
  const requests:Record<string,unknown>[]=[]
  const provider=createOpenAICompatible({name:'offline',baseURL:'https://offline.invalid/v1',fetch:async(_url,init)=>{
    requests.push(JSON.parse(String(init?.body)))
    return new Response('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'saved-model',choices:[{index:0,delta:{role:'assistant',content:'Hello'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  }})
  sdkWorkflow(t)
  t.mock.method(SubscriptionWorkflowModel.prototype,'doStream',(options:Parameters<SubscriptionWorkflowModel['doStream']>[0])=>provider('saved-model').doStream(options))
  await runHostedWorkflowTurn(runtime,{}, {messages:[{role:'user',content:'[Welcome] Synthetic greeting'}],toolChoice:'none',activeTools:[]})
  await runHostedWorkflowTurn(runtime,{registered:{inputSchema:jsonSchema({type:'object',properties:{}})}}, {prompt:'A real task'})
  assert.equal(requests.length,2)
  assert.equal(requests[0].tools,undefined);assert.equal(requests[0].tool_choice,undefined)
  assert.deepEqual((requests[1].tools as {function:{name:string}}[]).map(tool=>tool.function.name),['registered'])
})

test('a wire-level empty tool name ends with a safe failure instead of an empty successful turn',async t=>{
  let calls=0
  t.mock.method(console,'warn',()=>{})
  const provider=createOpenAICompatible({name:'offline',baseURL:'https://offline.invalid/v1',fetch:async()=>{
    calls++
    return new Response('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'saved-model',choices:[{index:0,delta:{tool_calls:[{index:0,id:'blank',type:'function',function:{name:'',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  }})
  sdkWorkflow(t)
  t.mock.method(SubscriptionWorkflowModel.prototype,'doStream',(options:Parameters<SubscriptionWorkflowModel['doStream']>[0])=>provider('saved-model').doStream(options))
  await assert.rejects(runHostedWorkflowTurn(runtime,{}, {prompt:'Synthetic request',stopWhen:isStepCount(120)}),{code:'model_tool_unavailable'})
  assert.equal(calls,1)
})
