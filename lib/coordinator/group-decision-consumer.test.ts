import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './decision'
import { invokeDecision } from './decide'
import { createGroupJudgment } from './group-judgment'
import { GroupJudgmentPendingError } from './group-correction'

const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002'
const members = [{id:a,name:'A',description:'role A'},{id:b,name:'B',description:'role B'}]

test('group consumer uses actual host receipt from synthetic REST response, not model prose', async () => {
  const oldFetch = globalThis.fetch, oldKey = process.env.DECISION_GATEWAY_API_KEY
  let requestBody = '', calls = 0
  process.env.DECISION_GATEWAY_API_KEY = 'synthetic-test-only'
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
    if (oldKey === undefined) delete process.env.DECISION_GATEWAY_API_KEY
    else process.env.DECISION_GATEWAY_API_KEY = oldKey
  }
})
