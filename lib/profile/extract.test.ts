import { after, before, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { clearFlagCache as clearRealFlagCache, serverFlagEnabled as readRealFlag } from '../posthog-server'

// Every switch in proactive.md § 3 stops the model call: the deployment
// switch, the PostHog flag (off or unavailable), 记忆 and the daily cap.
const saved = { key: process.env.ZEROCAT_API_KEY, url: process.env.ZEROCAT_BASE_URL, flag: process.env.PROACTIVE_PROFILE_ENABLED }
let flag: () => Promise<boolean | string | undefined> = async () => true
const generateText = mock.fn(async (_options: unknown) => ({ text: '{"facts": [{"kind": "tool", "subject": "Cloudflare Tunnel", "confidence": 0.7}]}', usage: { inputTokens: 100, outputTokens: 20 } }))
const store = { memoryEnabled: mock.fn(async () => true), claimExtractionCall: mock.fn(async () => true), recordExtractionTokens: mock.fn(async () => {}), recordFacts: mock.fn(async (_userId: string, facts: unknown[]) => facts.length), usageDay: () => '2026-10-28' }
const captured: unknown[] = []
let policyAllowed=true
const hostedCalls:string[]=[]
// This installation has no linked Cloud model service. The configured provider still runs through admission.
mock.module(new URL('../cloud-services/runtime.ts', import.meta.url).href, { namedExports: { cloudClient: {
  capability: async (userId: string, capability: string) => {
    assert.equal(userId, 'u1')
    assert.equal(capability, 'models')
    return null
  },
} } })
mock.module(new URL('../abuse/model.ts',import.meta.url).href,{namedExports:{
  admitHostedModel:async()=>{if(!policyAllowed)throw new Error('modelRouteDenied');return null},
  hostedModel:async(ws:string,modelId:string,provider:unknown,ownerId:string)=>{assert.equal(ws,'fixture-workspace');assert.equal(ownerId,'u1');assert.equal(provider,undefined);hostedCalls.push(modelId);return {modelId}},
}})
mock.module(new URL('../execution-settings.ts',import.meta.url).href,{namedExports:{executionWorkspace:async()=> 'fixture-workspace'}})
mock.module('ai', { namedExports: { generateText } })
// Inject the fake at our application boundary: mocking a dual-export SDK's
// package name alone can miss the import selected by a TypeScript loader.
const posthog = { getFeatureFlag: async () => flag(), capture(message: unknown) { captured.push(message) }, flush: async () => {} }
mock.module(new URL('../posthog-server.ts', import.meta.url).href, { namedExports: {
  clearFlagCache: clearRealFlagCache,
  serverFlagEnabled: (key: string, userId: string) => readRealFlag(key, userId, { posthog }),
  serverPostHog: () => posthog,
} })
mock.module(new URL('./store.ts', import.meta.url).href, { namedExports: store })
let extractFacts: typeof import('./extract')['extractFacts']
let clearFlagCache: typeof import('@/lib/posthog-server')['clearFlagCache']
before(async () => {
  ;({ extractFacts } = await import('./extract'))
  ;({ clearFlagCache } = await import('@/lib/posthog-server'))
})
beforeEach(() => {
  process.env.ZEROCAT_API_KEY = 'test-only-zerocat-key'
  process.env.ZEROCAT_BASE_URL = 'https://zero.cat/v1'
  process.env.PROACTIVE_PROFILE_ENABLED = '1'
  flag = async () => true
  clearFlagCache()
  generateText.mock.resetCalls()
  store.memoryEnabled.mock.mockImplementation(async () => true)
  store.claimExtractionCall.mock.mockImplementation(async () => true)
  store.claimExtractionCall.mock.resetCalls()
  captured.length = 0
  policyAllowed=true;hostedCalls.length=0
})
after(() => {
  for (const [name, value] of [['ZEROCAT_API_KEY', saved.key], ['ZEROCAT_BASE_URL', saved.url], ['PROACTIVE_PROFILE_ENABLED', saved.flag]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const mail: ExternalNotification = { userId: 'u1', source: 'gmail', externalId: 'm1', matterKey: 'gmail:t1', action: 'read', title: 'Cloudflare security advisory', url: null, actor: 'Cloudflare <noreply@cloudflare.com>', occurredAt: new Date('2026-10-27T10:00:00Z'), required: false, direct: false, fromSelf: false, automated: true, excerpt: 'Update cloudflared to 2026.10.2' }

test('with every switch on, one call writes facts and leaves generation capture to the model boundary', async () => {
  assert.equal(await extractFacts(mail, 's1'), 1)
  assert.equal(generateText.mock.callCount(), 1)
  const written = store.recordFacts.mock.calls.at(-1)?.arguments[1] as { source: { kind: string; id: string; url: string | null } }[]
  assert.deepEqual(written[0].source, { kind: 'thread', id: 'suggestion:s1', url: null }, 'the actual extraction call passes server-derived provenance to storage')
  assert.deepEqual(store.recordExtractionTokens.mock.calls.at(-1)?.arguments, ['u1', '2026-10-28', 100, 20])
  assert.equal(captured.length, 0, 'the extraction no longer emits a duplicate generation event')
  assert.ok(!JSON.stringify(captured).includes('cloudflared'), 'no prompt or answer goes to PostHog')
  // The default model, on its ZeroCat transport (hostedModel picks it).
  assert.deepEqual(hostedCalls,['deepseek/deepseek-v4.1-flash'])
})

test('a denied organization route sends nothing and does not consume the extraction daily cap',async t=>{
  t.mock.method(console,'error',()=>{})
  policyAllowed=false
  assert.equal(await extractFacts(mail,'s1'),0)
  assert.equal(store.claimExtractionCall.mock.callCount(),0)
  assert.equal(generateText.mock.callCount(),0)
  assert.equal(hostedCalls.length,0)
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
