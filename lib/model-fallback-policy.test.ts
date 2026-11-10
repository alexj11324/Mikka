import assert from 'node:assert/strict'
import test from 'node:test'
import { modelFallbackAllowed, type FallbackSource } from './model-fallback-policy'
import { organizationModelAllowed, organizationModelPolicySchema, readModelPolicy } from './organization-model-policy'

const source = (kind: 'subscription' | 'api_key', owner = 'alice', model = 'same-model', id = 'one', harness: 'codex' | 'claude_code' = 'codex'): FallbackSource => ({
  credentialOwnerId: owner, entry: { harness, model, source: kind === 'subscription' ? { kind, connectionId: id } : { kind, keyId: id } },
})
const defaults = { personalPaidFallback: false, organizationPaidFallback: false, recovery: true }

test('subscription exhaustion cannot silently start a paid API key', () => {
  assert.equal(modelFallbackAllowed(source('subscription'), source('api_key'), defaults), false)
  assert.equal(modelFallbackAllowed(source('subscription'), source('api_key'), { ...defaults, personalPaidFallback: true }), true)
})

test('explicit spending consent never changes model, Harness, or the payer during recovery', () => {
  const consent = { ...defaults, personalPaidFallback: true, organizationPaidFallback: true }
  assert.equal(modelFallbackAllowed(source('subscription'), source('api_key', 'bob'), consent), false)
  assert.equal(modelFallbackAllowed(source('subscription'), source('api_key', 'alice', 'other-model'), consent), false)
  assert.equal(modelFallbackAllowed(source('subscription'), source('api_key', 'alice', 'same-model', 'two', 'claude_code'), consent), false)
  assert.equal(modelFallbackAllowed(source('api_key'), source('api_key', 'organization:org'), consent), false)
})

test('Organization fallback needs its own consent; personal consent does not spend an Org connection', () => {
  const from = source('api_key', 'organization:org'), to = source('api_key', 'organization:org', 'same-model', 'two')
  assert.equal(modelFallbackAllowed(from, to, defaults), false)
  assert.equal(modelFallbackAllowed(from, to, { ...defaults, personalPaidFallback: true }), false)
  assert.equal(modelFallbackAllowed(from, to, { ...defaults, organizationPaidFallback: true }), true)
  assert.equal(modelFallbackAllowed(from, source('api_key', 'organization:other', 'same-model', 'two'), { ...defaults, organizationPaidFallback: true }), false)
})

test('normal automatic routing stays within its first authorized source without granting paid fallback', () => {
  assert.equal(modelFallbackAllowed(source('subscription'), source('subscription', 'alice', 'lighter-model'), { ...defaults, recovery: false }), true)
  assert.equal(modelFallbackAllowed(source('subscription'), source('api_key', 'alice', 'lighter-model'), { ...defaults, recovery: false }), false)
})

test('missing Organization policy denies paid fallback; malformed policy never falls back to allow', () => {
  const policy = readModelPolicy(null)
  assert.equal(policy.paidFallback, 'deny')
  assert.equal(organizationModelAllowed(policy, 'model', 'personal_subscription'), true)
  assert.throws(() => readModelPolicy({ sourceOrder: [], models: {}, paidFallback: 'same_payer' }))
})

test('model disable and forced Organization connection constrain every source, including wildcard defaults', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const policy = organizationModelPolicySchema.parse({ sourceOrder: ['organization','personal_subscription','personal_api_key','shared_api_key'], paidFallback: 'deny',
    models: { blocked: { mode: 'disabled' }, forced: { mode: 'organization_only', connectionId: id } } })
  for (const source of policy.sourceOrder) assert.equal(organizationModelAllowed(policy, 'blocked', source, id), false)
  assert.equal(organizationModelAllowed(policy, 'forced', 'organization', id), true)
  assert.equal(organizationModelAllowed(policy, 'forced', 'organization', '22222222-2222-4222-8222-222222222222'), false)
  assert.equal(organizationModelAllowed(policy, 'forced', 'personal_api_key', id), false)
  policy.models['*'] = { mode: 'disabled' }
  assert.equal(organizationModelAllowed(policy, 'forced', 'organization', id), false)
})
