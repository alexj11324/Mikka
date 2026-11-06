import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkflowAgent } from '@ai-sdk/workflow'
import { APICallError } from 'ai'
import type { ModelCallStreamPart } from '@ai-sdk/workflow'
import { runHostedWorkflowTurn } from './subscription-workflow-turn'
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const runtime={harness:'ai_sdk',model:'saved-model',modelSelection:{type:'subscription' as const,bindingId:id(3),ownerId:'alice',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'saved-model',route:'claude_cpa' as const}}
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
  const result=await runHostedWorkflowTurn({harness:'ai_sdk',model:'saved-default'}, {}, {prompt:'synthetic',writable,preventClose:true}, {ownerId:'alice',botId:null})
  assert.equal(result.text,'default');assert.equal(streamed,1)
  await assert.rejects(runHostedWorkflowTurn({...runtime,model:'different'}, {}, {prompt:'synthetic'}),/subscription_model_unavailable/)
  await assert.rejects(runHostedWorkflowTurn({harness:'ai_sdk',model:'saved-default'}, {}, {prompt:'synthetic'}),/verification_required/)
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
