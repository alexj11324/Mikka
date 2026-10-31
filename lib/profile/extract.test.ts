import { after, before, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExternalNotification } from '@/lib/suggestions/notification'

// Every switch in proactive.md § 3 stops the model call: the deployment
// switch, the PostHog flag (off or unavailable), 记忆 and the daily cap.
const saved = { key: process.env.DECISION_GATEWAY_API_KEY, flag: process.env.PROACTIVE_PROFILE_ENABLED }
let flag: () => Promise<boolean | string | undefined> = async () => true
const generateText = mock.fn(async (_options: unknown) => ({ text: '{"facts": [{"kind": "tool", "subject": "Cloudflare Tunnel", "confidence": 0.7}]}', usage: { inputTokens: 100, outputTokens: 20 } }))
const store = { memoryEnabled: mock.fn(async () => true), claimExtractionCall: mock.fn(async () => true), recordExtractionTokens: mock.fn(async () => {}), recordFacts: mock.fn(async (_userId: string, facts: unknown[]) => facts.length), usageDay: () => '2026-10-28' }
const captured: unknown[] = []
let policyAllowed=true
const trustedModels=new WeakSet<object>(),trustedCalls:Array<{model:string;key:string}>=[]
mock.module(new URL('../abuse/model.ts',import.meta.url).href,{namedExports:{
  createTrustedGatewayModel:async(model:string,key:string)=>{const provider={modelId:model};trustedModels.add(provider);trustedCalls.push({model,key});return provider},
  hostedModel:async(ws:string,_id:string,model:object,ownerId:string)=>{assert.equal(ws,'fixture-workspace');assert.equal(ownerId,'u1');assert.ok(trustedModels.has(model));return model},
}})
mock.module(new URL('../model-admission/runtime.ts',import.meta.url).href,{namedExports:{modelAdmission:{gateway:async()=>{if(!policyAllowed)throw new Error('modelRouteDenied');return null}}}})
mock.module(new URL('../execution-settings.ts',import.meta.url).href,{namedExports:{executionWorkspace:async()=> 'fixture-workspace'}})
mock.module('ai', { namedExports: { generateText } })
mock.module('posthog-node', { namedExports: { PostHog: class { getFeatureFlag() { return flag() } capture(message: unknown) { captured.push(message) } async flush() {} } } })
mock.module(new URL('./store.ts', import.meta.url).href, { namedExports: store })
let extractFacts: typeof import('./extract')['extractFacts']
let clearFlagCache: typeof import('@/lib/posthog-server')['clearFlagCache']
before(async () => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY ??= 'phc_test_only'
  ;({ extractFacts } = await import('./extract'))
  ;({ clearFlagCache } = await import('@/lib/posthog-server'))
})
beforeEach(() => {
  process.env.DECISION_GATEWAY_API_KEY = 'test-only-gateway-key'
  process.env.PROACTIVE_PROFILE_ENABLED = '1'
  flag = async () => true
  clearFlagCache()
  generateText.mock.resetCalls()
  store.memoryEnabled.mock.mockImplementation(async () => true)
  store.claimExtractionCall.mock.mockImplementation(async () => true)
  store.claimExtractionCall.mock.resetCalls()
  captured.length = 0
  policyAllowed=true;trustedCalls.length=0
})
after(() => {
  for (const [name, value] of [['DECISION_GATEWAY_API_KEY', saved.key], ['PROACTIVE_PROFILE_ENABLED', saved.flag]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const mail: ExternalNotification = { userId: 'u1', source: 'gmail', externalId: 'm1', matterKey: 'gmail:t1', action: 'read', title: 'Cloudflare security advisory', url: null, actor: 'Cloudflare <noreply@cloudflare.com>', occurredAt: new Date('2026-10-27T10:00:00Z'), required: false, direct: false, fromSelf: false, automated: true, excerpt: 'Update cloudflared to 2026.10.2' }

test('with every switch on, one call writes facts and reports usage without content', async () => {
  assert.equal(await extractFacts(mail, 's1'), 1)
  assert.equal(generateText.mock.callCount(), 1)
  assert.deepEqual(store.recordExtractionTokens.mock.calls.at(-1)?.arguments, ['u1', '2026-10-28', 100, 20])
  assert.equal((captured[0] as { event: string }).event, '$ai_generation')
  assert.ok(!JSON.stringify(captured).includes('cloudflared'), 'no prompt or answer goes to PostHog')
  assert.equal(trustedCalls[0].key,'test-only-gateway-key')
})

test('a denied organization route sends nothing and does not consume the extraction daily cap',async t=>{
  t.mock.method(console,'error',()=>{})
  policyAllowed=false
  assert.equal(await extractFacts(mail,'s1'),0)
  assert.equal(store.claimExtractionCall.mock.callCount(),0)
  assert.equal(generateText.mock.callCount(),0)
  assert.equal(trustedCalls.length,0)
})

test('the deployment switch off stops extraction before anything else', async () => {
  for (const value of [undefined, '0', 'false']) {
    if (value === undefined) delete process.env.PROACTIVE_PROFILE_ENABLED
    else process.env.PROACTIVE_PROFILE_ENABLED = value
    assert.equal(await extractFacts(mail, 's1'), 0)
  }
  assert.equal(generateText.mock.callCount(), 0)
})

test('the PostHog flag off or unavailable stops extraction', async t => {
  t.mock.method(console, 'error', () => {})
  for (const answer of [async () => false, async () => undefined, async () => 'true', async () => { throw new Error('PostHog unreachable') }]) {
    clearFlagCache()
    flag = answer
    assert.equal(await extractFacts(mail, 's1'), 0)
  }
  assert.equal(generateText.mock.callCount(), 0)
  assert.equal(store.claimExtractionCall.mock.callCount(), 0, 'no budget is spent for someone not entitled')
})

test('记忆 off or a spent daily budget stops extraction', async () => {
  store.memoryEnabled.mock.mockImplementation(async () => false)
  assert.equal(await extractFacts(mail, 's1'), 0)
  store.memoryEnabled.mock.mockImplementation(async () => true)
  store.claimExtractionCall.mock.mockImplementation(async () => false)
  assert.equal(await extractFacts(mail, 's1'), 0)
  assert.equal(generateText.mock.callCount(), 0)
})
