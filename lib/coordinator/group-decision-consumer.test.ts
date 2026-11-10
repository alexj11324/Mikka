import assert from 'node:assert/strict'
import test, { after, before, mock } from 'node:test'
import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './decision'
let invokeDecision: typeof import('./decide').invokeDecision
before(async () => { ({ invokeDecision } = await import('./decide')) })
import { createGroupJudgment } from './group-judgment'
import { GroupJudgmentPendingError } from './group-correction'
import { MockLanguageModelV3 } from 'ai/test'
import { replayGroupDecision, summarizeGroupDecisionReplay } from './group-decision-replay'
// Explicit server/billing fixtures; the REST payload remains synthetic.
let billingScope = { workspaceId: 'fixture-workspace', ownerId: 'fixture-owner', actorId: 'fixture-owner' }
mock.module(new URL('../abuse/context.ts',import.meta.url).href,{namedExports:{hostedBillingScope:{getStore:()=>billingScope}}})
mock.module(new URL('../abuse/runtime.ts',import.meta.url).href,{namedExports:{canUseMikkaPaid:async()=>{},hostedUsage:{reserve:async()=>{},settle:async()=>{}}}})
mock.module(new URL('../abuse/alerts.ts',import.meta.url).href,{namedExports:{checkAbuseAlerts:async()=>{}}})
mock.module(new URL('../credit-shares.ts',import.meta.url).href,{namedExports:{withSharedCredits:async(workspaceId:string,attempt:(payer:string)=>unknown)=>attempt(workspaceId)}})
mock.module(new URL('../model-admission/runtime.ts',import.meta.url).href,{namedExports:{assertUnmanagedModelTransport:async()=>{}}})
// This fixture exercises the Cloud gateway REST path; it has no connected community Cloud account.
const priorEdition = process.env.MIKKA_EDITION
before(() => { process.env.MIKKA_EDITION = 'cloud' })
after(() => { if (priorEdition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = priorEdition })
let groupReply: unknown
const generationInputs: unknown[] = []
const groupModel = new MockLanguageModelV3({ doGenerate: async options => {
  generationInputs.push(options)
  return { content: [{ type: 'text', text: JSON.stringify(groupReply) }], finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }
} })
mock.module(new URL('../abuse/model.ts', import.meta.url).href, { namedExports: { hostedModel: async (workspace: string, _model: string, _options: unknown, owner: string) => {
  assert.equal(workspace, 'fixture-workspace'); assert.equal(owner, 'fixture-owner'); return groupModel
} } })
mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: { workspaceDb: { select: () => { throw Error('No workspace I/O in model-consumer fixture') } } } })

const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002'
const members = [{id:a,name:'A',description:'role A'},{id:b,name:'B',description:'role B'}]

test('group consumer uses a sequential chain of actual host receipts from synthetic REST, not model prose', async () => {
  const oldFetch = globalThis.fetch, oldKey = process.env.AI_GATEWAY_API_KEY
  const requests:string[]=[]
  let calls=0
  process.env.AI_GATEWAY_API_KEY = 'synthetic-test-only'
  const validFetch:typeof fetch=async(_url,init)=>{
    calls++
    const requestBody=String(init?.body);requests.push(requestBody)
    const request=JSON.parse(requestBody)
    const values:Record<string,string>={responder_0:b,responder_1:'end',correction:'yes',target:b}
    return Response.json({model:DECISION_MODEL,executionId:'forged-from-provider',provider_metadata:{gateway:{generationId:`synthetic-${calls}`}},answers:request.questions.map((q:{name:string})=>({type:'choice',name:q.name,choice:values[q.name]}))})
  }
  globalThis.fetch=validFetch
  try {
    const judge=createGroupJudgment(invokeDecision,'group-route-v0')
    const route=await judge.route({text:'hello',mentions:[]},members,null,[])
    assert.equal(route.by,'model');assert.deepEqual(route.responders,[b]);assert.equal(route.decisions?.length,2)
    assert.equal(route.execution?.providerGenerationId,'synthetic-1')
    assert.notEqual(route.execution?.executionId,'forged-from-provider')
    assert.equal(route.execution?.requestDigest,createHash('sha256').update(requests[0]).digest('hex'))
    assert.deepEqual(requests.map(body=>JSON.parse(body).questions.map((q:{name:string})=>q.name)),[['responder_0'],['responder_1']])
    const correction=await judge.correction({previous:{message:'hello',responderId:a},current:{text:'actually B',mentions:[b]},members})
    assert.equal(correction.kind,'correction')
    if(correction.kind==='correction')assert.equal(correction.execution?.providerGenerationId,'synthetic-3')
    globalThis.fetch=async(_url,init)=>{
      const request=JSON.parse(String(init?.body));calls++
      return Response.json({model:DECISION_MODEL,provider_metadata:{gateway:{generationId:`low-${calls}`}},answers:request.questions.map((q:{name:string})=>({type:'choice',name:q.name,choice:q.name==='responder_0'?b:'end',confidence:0.05}))})
    }
    const low=await judge.route({text:'hello',mentions:[]},members,a,[])
    assert.deepEqual(low.responders,[b]);assert.equal(low.by==='model'?low.confidence:undefined,0.05)
    for(const invalid of ['model','metadata','refusal','missing','duplicate','foreign','uncertain']) {
      globalThis.fetch=async(_url,init)=>{
        const q=JSON.parse(String(init?.body)).questions[0];calls++
        const answer={type:'choice',name:q.name,choice:invalid==='foreign'?'not-a-member':invalid==='uncertain'?'uncertain':b}
        return Response.json({model:invalid==='model'?'unrelated-model':DECISION_MODEL,provider_metadata:invalid==='metadata'?{}:{gateway:{generationId:`bad-${calls}`}},answers:invalid==='refusal'?[{type:'refusal',name:q.name}]:invalid==='missing'?[]:invalid==='duplicate'?[answer,answer]:[answer]})
      }
      await assert.rejects(judge.route({text:'hello',mentions:[]},members,a,[]),GroupJudgmentPendingError)
    }
    globalThis.fetch=async()=>new Response(null,{status:503})
    await assert.rejects(judge.route({text:'hello',mentions:[]},members,null,[]),GroupJudgmentPendingError)
    assert.deepEqual(await judge.correction({previous:{message:'hello',responderId:a},current:{text:'x',mentions:[]},members}),{kind:'uncertain'})
  }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.AI_GATEWAY_API_KEY;else process.env.AI_GATEWAY_API_KEY=oldKey}
})

test('malformed paid responses remain null by default; only host group diagnostics can retain an unusable receipt',async()=>{
  const oldFetch=globalThis.fetch,oldKey=process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY='synthetic-test-only'
  globalThis.fetch=async()=>Response.json({model:DECISION_MODEL,provider_metadata:{gateway:{generationId:'synthetic-invalid-receipt'}},answers:[{type:'choice',name:'intent',choice:'outside-the-contract'}]})
  try {
    const questions=[{type:'choice' as const,name:'intent',instructions:'fixed fixture',choices:[{value:'ignore_ordinary_conversation'}]}]
    assert.equal(await invokeDecision('consumer-fixture','fixed fixture',questions),null)
    const retained=await invokeDecision('group-routing','fixed fixture',questions,undefined,{retainInvalidReceipt:true})
    assert.equal(retained?.validationFailure,'invalid_response');assert.equal(retained?.answers.size,0)
    assert.equal(retained?.execution.providerGenerationId,'synthetic-invalid-receipt')
    const row=await replayGroupDecision('small-talk','group-contribution-v1',invokeDecision)
    assert.equal(row.status,'invalid_decision');assert.equal(row.route,null);assert.equal(row.failureReason,'invalid_response')
    assert.equal(row.decisions[0].receipt?.providerGenerationId,'synthetic-invalid-receipt')
  }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.AI_GATEWAY_API_KEY;else process.env.AI_GATEWAY_API_KEY=oldKey}
})

test('fixed replay uses invokeDecision host receipts and refuses a receipt-less REST response',async()=>{
  const oldFetch=globalThis.fetch,oldKey=process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY='synthetic-test-only'
  let requestBody='',omitReceipt=false
  globalThis.fetch=async(_url,init)=>{
    requestBody=String(init?.body)
    const request=JSON.parse(requestBody)
    assert.equal(request.model,DECISION_MODEL);assert.equal(request.questions.length,1)
    assert.equal(request.questions[0].name,'intent')
    assert.ok(!JSON.stringify(request.input).includes('maxPublicMessages'))
    return Response.json({model:DECISION_MODEL,provider_metadata:omitReceipt?{}:{gateway:{generationId:'synthetic-replay-generation'}},answers:[{type:'choice',name:'intent',choice:'ignore_ordinary_conversation'}]})
  }
  try {
    const row=await replayGroupDecision('small-talk','group-contribution-v1',invokeDecision)
    assert.equal(row.status,'complete');assert.equal(row.route?.action,'ignore');assert.equal(row.executionPerformed,false)
    assert.equal(row.receipt?.providerGenerationId,'synthetic-replay-generation')
    assert.equal(row.receipt?.requestDigest,createHash('sha256').update(requestBody).digest('hex'))
    assert.equal(row.decisions.length,1)
    omitReceipt=true
    const unavailable=await replayGroupDecision('small-talk','group-contribution-v1',invokeDecision)
    assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.route,null);assert.equal(summarizeGroupDecisionReplay([unavailable]).measured,0)
  }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.AI_GATEWAY_API_KEY;else process.env.AI_GATEWAY_API_KEY=oldKey}
})

test('actual structured generation distinguishes public/private output and validates the peer UUID', async () => {
  const { groupRuntime } = await import('./group-runtime')
  for (const privateTo of [null, b]) {
    groupReply = { text: 'synthetic group reply', mentions: [], privateTo }
    const result = await groupRuntime.generate(members[0], { message: { text: 'source group', mentions: [] }, earlier: [], followUp: '', members, privatePeer: members[1] })
    assert.deepEqual(result, groupReply)
    const request = generationInputs.at(-1) as { responseFormat: { schema: { required: string[] } }; prompt: Array<{ role: string; content: Array<{ text: string }> }> }
    assert.ok(request.responseFormat.schema.required.includes('privateTo'))
    const input = JSON.parse(request.prompt.find(entry => entry.role === 'user')!.content[0].text)
    assert.equal(input.privatePeer.id, b)
  }
  groupReply = { text: 'invalid private peer', mentions: [], privateTo: 'not-an-agent-id' }
  await assert.rejects(groupRuntime.generate(members[0], { message: { text: 'source group', mentions: [] }, earlier: [], followUp: '', members }))
})

test('Bot group generation reuses frozen binding references and streaming, without a paid-default fallback', async t => {
  const { groupRuntime } = await import('./group-runtime')
  const actualSnapshot = await import('../subscription-model-snapshot')
  const workspaceId = '00000000-0000-4000-8000-000000000003'
  const scope = { ownerId: 'fixture-owner', actorId: 'fixture-owner', workspaceId, botId: a }
  const selection = { type: 'subscription' as const, bindingId: '00000000-0000-4000-8000-000000000004', ...scope,
    consumerId: a, connectionId: '00000000-0000-4000-8000-000000000005', connectionRevision: 1, modelId: 'fixture-bot-model', route: 'openai_siwc' as const }
  // The snapshot has consumerId; botId is a host scope field, not persisted data.
  const { botId: _botId, ...safeSelection } = selection
  let refusal = false, invalid = false, streams = 0
  let streamError: unknown
  const streamModel = new MockLanguageModelV3({ doStream: async () => {
    streams++
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      if (streamError) { controller.enqueue({type:'error',error:streamError});controller.close();return }
      controller.enqueue({ type: 'text-start', id: 'fixture' })
      controller.enqueue({ type: 'text-delta', id: 'fixture', delta: JSON.stringify({ text: 'streamed Bot reply', mentions: [], privateTo: null }) })
      controller.enqueue({ type: 'text-end', id: 'fixture' })
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } })
      controller.close()
    } }) }
  } })
  const handles = [
    mock.module(new URL('../bot-model-selection.ts', import.meta.url).href, { namedExports: { freezeBotModel: async (actual: unknown) => {
      assert.deepEqual(actual, scope)
      if (refusal) throw Object.assign(Error('binding required'), { code: 'binding_required' })
      return { harness: 'ai_sdk', actorId: scope.actorId, model: safeSelection.modelId, modelSelection: { ...safeSelection, ...(invalid ? { bearer: 'fixture-must-be-rejected' } : {}) }, secret: 'fixture-must-not-be-persisted' }
    } } }),
    mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: { subscriptionRuntime: () => { throw Error('No external subscription access in fixture') }, authorizeSubscriptionWorkspace: async () => {} } }),
    mock.module(new URL('../subscription-model-snapshot.ts', import.meta.url).href, { namedExports: { ...actualSnapshot, resolveFrozenHostedModel: async (actual: unknown, frozen: unknown) => {
      assert.deepEqual(actual, scope); assert.deepEqual(frozen, { harness: 'ai_sdk', actorId: scope.actorId, model: safeSelection.modelId, modelSelection: safeSelection }); return streamModel
    } } }),
  ]
  const previous = billingScope
  t.after(() => { billingScope = previous; for (const handle of handles.reverse()) handle.restore() })
  billingScope = { workspaceId, ownerId: scope.ownerId, actorId: scope.actorId }
  const bot = { ...members[0], memberType: 'bot' as const }
  const client = { query: () => { throw Error('No unbound database query in model fixture') } } as unknown as import('pg').PoolClient
  const frozen = await groupRuntime.prepareBot!(bot, { ownerId: scope.ownerId, actorId: scope.actorId, workspaceId }, client)
  assert.deepEqual(frozen, { harness: 'ai_sdk', actorId: scope.actorId, model: safeSelection.modelId, modelSelection: safeSelection })
  assert.deepEqual(await groupRuntime.generate(bot, { message: { text: 'source group', mentions: [] }, earlier: [], followUp: '', members, modelRuntime: frozen }), { text: 'streamed Bot reply', mentions: [], privateTo: null })
  assert.equal(streams, 1)
  streamError = Object.assign(new Error('private provider detail'), { statusCode: 503 })
  await assert.rejects(groupRuntime.generate(bot, { message: { text: 'source group', mentions: [] }, earlier: [], followUp: '', members, modelRuntime: frozen }), error => error === streamError)
  streamError = undefined
  const callsBeforeRefusal = streams
  await assert.rejects(groupRuntime.generate(bot, { message: { text: 'source group', mentions: [] }, earlier: [], followUp: '', members }), /model_unavailable/)
  refusal = true
  await assert.rejects(groupRuntime.prepareBot!(bot, { ownerId: scope.ownerId, actorId: scope.actorId, workspaceId }, client), { code: 'binding_required' })
  refusal = false; invalid = true
  await assert.rejects(groupRuntime.prepareBot!(bot, { ownerId: scope.ownerId, actorId: scope.actorId, workspaceId }, client))
  assert.equal(streams, callsBeforeRefusal, 'refusal or an invalid frozen reference never reaches a fallback model')
})
