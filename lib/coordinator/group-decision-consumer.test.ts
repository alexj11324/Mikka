import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './decision'
import { invokeDecision } from './decide'
import { createGroupJudgment } from './group-judgment'
import { GroupJudgmentPendingError } from './group-correction'
import { MockLanguageModelV3 } from 'ai/test'
// Explicit server/billing fixtures; the REST payload remains synthetic.
let billingScope = { workspaceId: 'fixture-workspace', ownerId: 'fixture-owner' }
mock.module(new URL('../abuse/context.ts',import.meta.url).href,{namedExports:{hostedBillingScope:{getStore:()=>billingScope}}})
mock.module(new URL('../abuse/runtime.ts',import.meta.url).href,{namedExports:{canUseMikkaPaid:async()=>{},hostedUsage:{reserve:async()=>{},settle:async()=>{}}}})
mock.module(new URL('../abuse/alerts.ts',import.meta.url).href,{namedExports:{checkAbuseAlerts:async()=>{}}})
mock.module(new URL('../model-admission/runtime.ts',import.meta.url).href,{namedExports:{assertUnmanagedModelTransport:async()=>{}}})
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

test('group consumer uses actual host receipt from synthetic REST response, not model prose', async () => {
  const oldFetch = globalThis.fetch, oldKey = process.env.AI_GATEWAY_API_KEY
  let requestBody = '', calls = 0
  process.env.AI_GATEWAY_API_KEY = 'synthetic-test-only'
  globalThis.fetch = async (_url, init) => {
    calls++
    requestBody = String(init?.body)
    const request = JSON.parse(requestBody)
    const names = request.questions.map((q: {name:string}) => q.name)
    const answers = names.includes('correction')
      ? [{type:'choice',name:'correction',choice:'yes'}, {type:'choice',name:'target',choice:b}]
      : [{type:'choice',name:'responder_0',choice:b}, {type:'choice',name:'responder_1',choice:'end'}]
    return Response.json({model:DECISION_MODEL,executionId:'forged-from-provider',provider_metadata:{gateway:{generationId:`synthetic-${calls}`}},answers})
  }
  try {
    const judge = createGroupJudgment(invokeDecision)
    const route = await judge.route({text:'hello',mentions:[]},members,null,[])
    assert.equal(route.by,'model')
    if (route.by !== 'model') throw Error('expected model route')
    assert.deepEqual(route.responders,[b]); assert.equal(route.confidence,undefined)
    assert.equal(route.execution?.providerGenerationId,'synthetic-1')
    assert.notEqual(route.execution?.executionId,'forged-from-provider')
    assert.equal(route.execution?.requestDigest,createHash('sha256').update(requestBody).digest('hex'))
    assert.equal(route.execution?.vision,'no-image-input')
    const correction = await judge.correction({previous:{message:'hello',responderId:a},current:{text:'actually B',mentions:[b]},members})
    assert.equal(correction.kind,'correction')
    if (correction.kind !== 'correction') throw Error('expected correction')
    assert.equal(correction.execution?.providerGenerationId,'synthetic-2')
    assert.equal(correction.execution?.requestDigest,createHash('sha256').update(requestBody).digest('hex'))
    const envelope = (answers: unknown[]) => ({model:DECISION_MODEL,provider_metadata:{gateway:{generationId:'synthetic-validation'}},answers})
    const validAnswers = [{type:'choice',name:'responder_0',choice:b,confidence:0.05}, {type:'choice',name:'responder_1',choice:'end'}]
    globalThis.fetch = async () => Response.json(envelope(validAnswers))
    const lowConfidence = await judge.route({text:'hello',mentions:[]},members,a,[])
    assert.deepEqual(lowConfidence.responders,[b])
    assert.equal(lowConfidence.by,'model')
    assert.equal(lowConfidence.by === 'model' ? lowConfidence.confidence : undefined,0.05)
    // Validated host evidence must exist for every route. These are synthetic
    // provider responses, including refusal and uncertainty, not live acceptance.
    for (const payload of [
      {...envelope(validAnswers),model:'unrelated-model'},
      {...envelope(validAnswers),provider_metadata:{}},
      envelope([{type:'refusal',name:'responder_0'}, validAnswers[1]]),
      envelope([validAnswers[0]]),
      envelope([validAnswers[0],validAnswers[0],validAnswers[1]]),
      envelope([{...validAnswers[0],choice:'not-a-member'},validAnswers[1]]),
      envelope([validAnswers[0],{...validAnswers[1],choice:'uncertain'}]),
    ]) {
      globalThis.fetch = async () => Response.json(payload)
      await assert.rejects(judge.route({text:'hello',mentions:[]},members,a,[]),GroupJudgmentPendingError)
    }
    globalThis.fetch = async () => new Response(null,{status:503})
    await assert.rejects(judge.route({text:'hello',mentions:[]},members,null,[]),GroupJudgmentPendingError)
    assert.deepEqual(await judge.correction({previous:{message:'hello',responderId:a},current:{text:'x',mentions:[]},members}),{kind:'uncertain'})
  } finally {
    globalThis.fetch = oldFetch
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = oldKey
  }
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
  const scope = { ownerId: 'fixture-owner', workspaceId, botId: a }
  const selection = { type: 'subscription' as const, bindingId: '00000000-0000-4000-8000-000000000004', ...scope,
    consumerId: a, connectionId: '00000000-0000-4000-8000-000000000005', connectionRevision: 1, modelId: 'fixture-bot-model', route: 'openai_siwc' as const }
  // The snapshot has consumerId; botId is a host scope field, not persisted data.
  const { botId: _botId, ...safeSelection } = selection
  let refusal = false, invalid = false, streams = 0
  const streamModel = new MockLanguageModelV3({ doStream: async () => {
    streams++
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
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
      return { harness: 'ai_sdk', model: safeSelection.modelId, modelSelection: { ...safeSelection, ...(invalid ? { bearer: 'fixture-must-be-rejected' } : {}) }, secret: 'fixture-must-not-be-persisted' }
    } } }),
    mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: { subscriptionRuntime: () => { throw Error('No external subscription access in fixture') }, authorizeSubscriptionWorkspace: async () => {} } }),
    mock.module(new URL('../subscription-model-snapshot.ts', import.meta.url).href, { namedExports: { ...actualSnapshot, resolveFrozenHostedModel: async (actual: unknown, frozen: unknown) => {
      assert.deepEqual(actual, scope); assert.deepEqual(frozen, { harness: 'ai_sdk', model: safeSelection.modelId, modelSelection: safeSelection }); return streamModel
    } } }),
  ]
  const previous = billingScope
  t.after(() => { billingScope = previous; for (const handle of handles.reverse()) handle.restore() })
  billingScope = { workspaceId, ownerId: scope.ownerId }
  const bot = { ...members[0], memberType: 'bot' as const }
  const client = { query: () => { throw Error('No unbound database query in model fixture') } } as unknown as import('pg').PoolClient
  const frozen = await groupRuntime.prepareBot!(bot, { ownerId: scope.ownerId, workspaceId }, client)
  assert.deepEqual(frozen, { harness: 'ai_sdk', model: safeSelection.modelId, modelSelection: safeSelection })
  assert.deepEqual(await groupRuntime.generate(bot, { message: { text: 'source group', mentions: [] }, earlier: [], followUp: '', members, modelRuntime: frozen }), { text: 'streamed Bot reply', mentions: [], privateTo: null })
  assert.equal(streams, 1)
  await assert.rejects(groupRuntime.generate(bot, { message: { text: 'source group', mentions: [] }, earlier: [], followUp: '', members }), /model_unavailable/)
  refusal = true
  await assert.rejects(groupRuntime.prepareBot!(bot, { ownerId: scope.ownerId, workspaceId }, client), { code: 'binding_required' })
  refusal = false; invalid = true
  await assert.rejects(groupRuntime.prepareBot!(bot, { ownerId: scope.ownerId, workspaceId }, client))
  assert.equal(streams, 1, 'refusal or an invalid frozen reference never reaches a fallback model')
})
